import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

/**
 * NoblePay × SealSettlementGate — enforced top assurance tier.
 *
 * Behavioral integration suite over the REAL contract stack: the only mock is
 * the ISeal precompile boundary (MockISeal installed at 0x0900 via setCode —
 * state populated after install). NoblePay and SealSettlementGate are the
 * production contracts, so a settlement exercises the full path:
 *
 *   initiate (escrow) → TEE PASSED (role-trusted tier)
 *     → MockISeal(0x0900) → SealSettlementGate.isCleared → funds move
 *
 * The property under test: a role-held TEE key alone can no longer move
 * funds — the validator quorum's corridor seal is a second, consensus-anchored
 * factor at the settlement choke point.
 */
describe("NoblePay — seal-gated settlement (enforced tier)", function () {
  const SEAL_PRECOMPILE = "0x0000000000000000000000000000000000000900";
  const JOB = "job-screen-001";
  const SEAL_ID = "a".repeat(64);
  const USD = "0x555344";

  const purposeFor = (payer, payee) =>
    `noblepay:${payer.toLowerCase()}:${payee.toLowerCase()}`;

  async function deployFixture() {
    const [admin, treasury, teeNode, business1, recipient, stranger] =
      await ethers.getSigners();

    // Real precompile boundary: MockISeal runtime code at 0x0900.
    const MockISeal = await ethers.getContractFactory("MockISeal");
    const deployed = await MockISeal.deploy();
    await deployed.waitForDeployment();
    const runtime = await ethers.provider.getCode(deployed.target);
    await networkHelpers.setCode(SEAL_PRECOMPILE, runtime);
    const seal = MockISeal.attach(SEAL_PRECOMPILE);
    await seal.setPolicyResult(true, "");

    // Real gate.
    const Gate = await ethers.getContractFactory("SealSettlementGate");
    const gate = await Gate.deploy(admin.address);
    await gate.waitForDeployment();

    // Real NoblePay.
    const NoblePay = await ethers.getContractFactory("NoblePay");
    const noblepay = await NoblePay.deploy(
      admin.address,
      treasury.address,
      ethers.parseUnits("1", 6),
      50,
    );

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const TEE_NODE_ROLE = await noblepay.TEE_NODE_ROLE();
    await noblepay.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true);

    const amount = ethers.parseUnits("1000000", 6);
    await usdc.mint(business1.address, amount);
    await usdc.connect(business1).approve(noblepay.target, amount);

    return {
      noblepay,
      gate,
      seal,
      usdc,
      admin,
      treasury,
      teeNode,
      business1,
      recipient,
      stranger,
    };
  }

  /** initiate → TEE PASSED; returns paymentId (role-trusted tier complete). */
  async function passedPayment(f, amountUnits = "100") {
    const amount = ethers.parseUnits(amountUnits, 6);
    const tx = await f.noblepay
      .connect(f.business1)
      .initiatePayment(
        f.recipient.address,
        amount,
        f.usdc.target,
        ethers.ZeroHash,
        USD,
      );
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (l) => l.fragment && l.fragment.name === "PaymentInitiated",
    );
    const paymentId = event.args[0];

    await f.noblepay
      .connect(f.teeNode)
      .submitComplianceResult(
        paymentId,
        true,
        10,
        true,
        ethers.keccak256("0x01"),
        "0x1234",
      );
    return paymentId;
  }

  /** Seed a corridor-bound ACTIVE seal and clear it in the real gate. */
  async function clearCorridor(f, { job = JOB, sealId = SEAL_ID } = {}) {
    await f.seal.setSeal(
      job,
      sealId,
      purposeFor(f.business1.address, f.recipient.address),
      true,
    );
    await f.gate.clear(f.business1.address, f.recipient.address, job);
  }

  describe("defaults (tier opt-in until governance enables it)", function () {
    it("deploys with no gate and enforcement off", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      expect(await f.noblepay.sealGate()).to.equal(ethers.ZeroAddress);
      expect(await f.noblepay.sealClearanceRequired()).to.equal(false);
    });

    it("settles without any seal infrastructure when enforcement is off", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      const paymentId = await passedPayment(f);
      await expect(f.noblepay.settlePayment(paymentId)).to.emit(
        f.noblepay,
        "PaymentSettled",
      );
    });
  });

  describe("governance wiring (fail-closed)", function () {
    it("cannot enable enforcement without a gate", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(
        f.noblepay.connect(f.admin).setSealClearanceRequired(true),
      ).to.be.revertedWithCustomError(f.noblepay, "SealGateNotSet");
    });

    it("setSealGate emits and stores; enforcement then enables", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await expect(f.noblepay.connect(f.admin).setSealGate(f.gate.target))
        .to.emit(f.noblepay, "SealGateUpdated")
        .withArgs(ethers.ZeroAddress, f.gate.target);

      await expect(f.noblepay.connect(f.admin).setSealClearanceRequired(true))
        .to.emit(f.noblepay, "SealClearanceRequirementUpdated")
        .withArgs(true);
      expect(await f.noblepay.sealClearanceRequired()).to.equal(true);
    });

    it("clearing the gate auto-disables enforcement (never required-without-gate)", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      await f.noblepay.connect(f.admin).setSealGate(f.gate.target);
      await f.noblepay.connect(f.admin).setSealClearanceRequired(true);

      await expect(f.noblepay.connect(f.admin).setSealGate(ethers.ZeroAddress))
        .to.emit(f.noblepay, "SealClearanceRequirementUpdated")
        .withArgs(false);
      expect(await f.noblepay.sealClearanceRequired()).to.equal(false);

      // Settlement path is open again (tier back to opt-in).
      const paymentId = await passedPayment(f);
      await expect(f.noblepay.settlePayment(paymentId)).to.emit(
        f.noblepay,
        "PaymentSettled",
      );
    });

    it("both setters are ADMIN_ROLE-only", async function () {
      const f = await networkHelpers.loadFixture(deployFixture);
      const adminRole = await f.noblepay.ADMIN_ROLE();
      const denied = `AccessControl: account ${f.stranger.address.toLowerCase()} is missing role ${adminRole}`;
      await expect(
        f.noblepay.connect(f.stranger).setSealGate(f.gate.target),
      ).to.be.revertedWith(denied);
      await expect(
        f.noblepay.connect(f.stranger).setSealClearanceRequired(false),
      ).to.be.revertedWith(denied);
    });
  });

  describe("enforced settlement (the moat, end to end)", function () {
    async function enforcedFixture() {
      const f = await networkHelpers.loadFixture(deployFixture);
      await f.noblepay.connect(f.admin).setSealGate(f.gate.target);
      await f.noblepay.connect(f.admin).setSealClearanceRequired(true);
      return f;
    }

    it("a TEE-PASSED payment cannot settle without a corridor seal — the role-held key is not enough", async function () {
      const f = await enforcedFixture();
      const paymentId = await passedPayment(f);

      await expect(f.noblepay.settlePayment(paymentId))
        .to.be.revertedWithCustomError(f.noblepay, "SealClearanceMissing")
        .withArgs(f.business1.address, f.recipient.address);
    });

    it("settles when the corridor carries a live consensus clearance — full real-contract path", async function () {
      const f = await enforcedFixture();
      const paymentId = await passedPayment(f);
      await clearCorridor(f);

      const balBefore = await f.usdc.balanceOf(f.recipient.address);
      await expect(f.noblepay.settlePayment(paymentId)).to.emit(
        f.noblepay,
        "PaymentSettled",
      );
      expect(await f.usdc.balanceOf(f.recipient.address)).to.be.gt(balBefore);
    });

    it("consensus seal revocation closes the corridor mid-flight — escrowed funds cannot exit", async function () {
      const f = await enforcedFixture();
      const paymentId = await passedPayment(f);
      await clearCorridor(f);

      // Sanctions-list update: the chain revokes the corridor seal AFTER the
      // TEE passed the payment and BEFORE settlement.
      await f.seal.setActive(SEAL_ID, false);

      await expect(
        f.noblepay.settlePayment(paymentId),
      ).to.be.revertedWithCustomError(f.noblepay, "SealClearanceMissing");
    });

    it("governance clearance revocation blocks settlement", async function () {
      const f = await enforcedFixture();
      const paymentId = await passedPayment(f);
      await clearCorridor(f);
      await f.gate
        .connect(f.admin)
        .revoke(f.business1.address, f.recipient.address);

      await expect(
        f.noblepay.settlePayment(paymentId),
      ).to.be.revertedWithCustomError(f.noblepay, "SealClearanceMissing");
    });

    it("a clearance for a different corridor does not admit this payment", async function () {
      const f = await enforcedFixture();
      const paymentId = await passedPayment(f);

      // Seal + clearance bound to (business1 → stranger), not (business1 → recipient).
      await f.seal.setSeal(
        JOB,
        SEAL_ID,
        purposeFor(f.business1.address, f.stranger.address),
        true,
      );
      await f.gate.clear(f.business1.address, f.stranger.address, JOB);

      await expect(
        f.noblepay.settlePayment(paymentId),
      ).to.be.revertedWithCustomError(f.noblepay, "SealClearanceMissing");
    });

    it("still enforces the TEE tier on top of the seal: a BLOCKED payment cannot settle even with a cleared corridor", async function () {
      const f = await enforcedFixture();
      await clearCorridor(f);

      const amount = ethers.parseUnits("100", 6);
      const tx = await f.noblepay
        .connect(f.business1)
        .initiatePayment(
          f.recipient.address,
          amount,
          f.usdc.target,
          ethers.ZeroHash,
          USD,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      // TEE blocks it (sanctions hit) — the tiers complement each other.
      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(
          paymentId,
          false,
          10,
          true,
          ethers.keccak256("0x01"),
          "0x1234",
        );

      await expect(
        f.noblepay.settlePayment(paymentId),
      ).to.be.revertedWithCustomError(f.noblepay, "InvalidPaymentStatus");
    });

    it("refunds remain possible while the corridor is closed (funds return, never exit forward)", async function () {
      const f = await enforcedFixture();

      const amount = ethers.parseUnits("100", 6);
      const tx = await f.noblepay
        .connect(f.business1)
        .initiatePayment(
          f.recipient.address,
          amount,
          f.usdc.target,
          ethers.ZeroHash,
          USD,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(
          paymentId,
          false,
          10,
          true,
          ethers.keccak256("0x01"),
          "0x1234",
        );

      // No corridor clearance exists; the refund path (back to sender) is
      // deliberately NOT seal-gated.
      await expect(f.noblepay.refundPayment(paymentId)).to.emit(
        f.noblepay,
        "PaymentRefunded",
      );
    });
  });
});
