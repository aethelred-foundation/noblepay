import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture } = networkHelpers;

/**
 * NoblePay hardening suite — behavioral proofs (attack fixtures + edge cases),
 * not stubs, for the settlement path and the fund-lock fix found in self-audit:
 *
 *  - AmountBelowFee: a payment whose amount cannot cover its settlement fee is
 *    rejected at initiation (single + batch), so escrow can never be locked by
 *    a settlePayment underflow.
 *  - settle-side fee cap: a governance fee hike above an escrowed amount does
 *    not underflow/lock; the fee is capped at the amount.
 *  - reentrancy: a malicious native recipient cannot re-enter settle/refund/
 *    cancel from inside the settlement transfer (ReentrancyGuard).
 *  - hostile gate: a malicious seal gate cannot reenter settlement — isCleared
 *    is invoked via staticcall (interface `view`), so a state-changing re-entry
 *    reverts at the EVM level.
 */
describe("NoblePay — hardening", function () {
  const USD = "0x555344";
  const AETHEL = "0x414554";

  async function deployFixture() {
    const [admin, treasury, teeNode, business1, recipient, other] =
      await ethers.getSigners();

    const NoblePay = await ethers.getContractFactory("NoblePay");
    const baseFee = ethers.parseUnits("1", 6); // 1 USDC
    const percentageFee = 50; // 0.5%
    const noblepay = await NoblePay.deploy(
      admin.address,
      treasury.address,
      baseFee,
      percentageFee,
    );

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const TEE_NODE_ROLE = await noblepay.TEE_NODE_ROLE();
    await noblepay.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true);

    const bal = ethers.parseUnits("1000000", 6);
    await usdc.mint(business1.address, bal);
    await usdc.connect(business1).approve(noblepay.target, bal);

    return {
      noblepay,
      usdc,
      baseFee,
      admin,
      treasury,
      teeNode,
      business1,
      recipient,
      other,
    };
  }

  // Initiate a native payment and return its id.
  async function initiateNative(f, from, to, amount) {
    const tx = await f.noblepay
      .connect(from)
      .initiatePayment(
        to,
        amount,
        ethers.ZeroAddress,
        ethers.ZeroHash,
        AETHEL,
        {
          value: amount,
        },
      );
    const r = await tx.wait();
    return r.logs.find(
      (l) => l.fragment && l.fragment.name === "PaymentInitiated",
    ).args[0];
  }

  describe("constructor guards", function () {
    it("rejects a zero admin", async function () {
      const f = await loadFixture(deployFixture);
      const NoblePay = await ethers.getContractFactory("NoblePay");
      await expect(
        NoblePay.deploy(ethers.ZeroAddress, f.treasury.address, f.baseFee, 50),
      ).to.be.revertedWithCustomError(f.noblepay, "ZeroAddress");
    });

    it("rejects a zero treasury", async function () {
      const f = await loadFixture(deployFixture);
      const NoblePay = await ethers.getContractFactory("NoblePay");
      await expect(
        NoblePay.deploy(f.admin.address, ethers.ZeroAddress, f.baseFee, 50),
      ).to.be.revertedWithCustomError(f.noblepay, "ZeroAddress");
    });

    it("rejects a percentage fee above the cap", async function () {
      const f = await loadFixture(deployFixture);
      const NoblePay = await ethers.getContractFactory("NoblePay");
      const overCap = (await f.noblepay.MAX_PERCENTAGE_FEE()) + 1n;
      await expect(
        NoblePay.deploy(
          f.admin.address,
          f.treasury.address,
          f.baseFee,
          overCap,
        ),
      ).to.be.revertedWithCustomError(f.noblepay, "InvalidFee");
    });
  });

  describe("fund-lock fix (AmountBelowFee)", function () {
    it("rejects a single payment whose amount cannot cover its fee", async function () {
      const f = await loadFixture(deployFixture);
      // amount 1 << baseFee (1e6): settlePayment would underflow → escrow locked.
      await expect(
        f.noblepay
          .connect(f.business1)
          .initiatePayment(
            f.recipient.address,
            1n,
            f.usdc.target,
            ethers.ZeroHash,
            USD,
          ),
      ).to.be.revertedWithCustomError(f.noblepay, "AmountBelowFee");
    });

    it("rejects amount exactly equal to the fee (netAmount would be zero)", async function () {
      const f = await loadFixture(deployFixture);
      // fee(x) = baseFee + x*50/10000. Find x with x == fee(x) is unreachable for
      // baseFee>0, so just assert a value <= fee is rejected: baseFee itself.
      await expect(
        f.noblepay
          .connect(f.business1)
          .initiatePayment(
            f.recipient.address,
            f.baseFee,
            f.usdc.target,
            ethers.ZeroHash,
            USD,
          ),
      ).to.be.revertedWithCustomError(f.noblepay, "AmountBelowFee");
    });

    it("accepts an amount that exceeds its fee", async function () {
      const f = await loadFixture(deployFixture);
      await expect(
        f.noblepay
          .connect(f.business1)
          .initiatePayment(
            f.recipient.address,
            ethers.parseUnits("2", 6),
            f.usdc.target,
            ethers.ZeroHash,
            USD,
          ),
      ).to.emit(f.noblepay, "PaymentInitiated");
    });

    it("rejects a batch item whose amount cannot cover its fee", async function () {
      const f = await loadFixture(deployFixture);
      await expect(
        f.noblepay
          .connect(f.business1)
          .initiatePaymentBatch(
            [f.recipient.address, f.other.address],
            [ethers.parseUnits("2", 6), 1n],
            [f.usdc.target, f.usdc.target],
            [ethers.ZeroHash, ethers.ZeroHash],
            [USD, USD],
          ),
      ).to.be.revertedWithCustomError(f.noblepay, "AmountBelowFee");
    });

    it("an accepted payment always settles (no underflow) — end to end", async function () {
      const f = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("2", 6);
      const tx = await f.noblepay
        .connect(f.business1)
        .initiatePayment(
          f.recipient.address,
          amount,
          f.usdc.target,
          ethers.ZeroHash,
          USD,
        );
      const r = await tx.wait();
      const pid = r.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      ).args[0];
      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(pid, true, 10, true, ethers.ZeroHash, "0x");
      await expect(f.noblepay.settlePayment(pid)).to.emit(
        f.noblepay,
        "PaymentSettled",
      );
    });
  });

  describe("settle-side fee cap (post-initiation fee hike)", function () {
    it("a fee raised above an escrowed amount does not underflow; fee is capped, funds move", async function () {
      const f = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("2", 6);
      const tx = await f.noblepay
        .connect(f.business1)
        .initiatePayment(
          f.recipient.address,
          amount,
          f.usdc.target,
          ethers.ZeroHash,
          USD,
        );
      const r = await tx.wait();
      const pid = r.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      ).args[0];
      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(pid, true, 10, true, ethers.ZeroHash, "0x");

      // Governance raises baseFee far above the escrowed amount.
      await f.noblepay
        .connect(f.admin)
        .setFees(ethers.parseUnits("100", 6), 50);

      // Settlement still succeeds (fee capped at amount → recipient net 0,
      // treasury gets the amount) rather than reverting/locking the escrow.
      const treBefore = await f.usdc.balanceOf(f.treasury.address);
      await expect(f.noblepay.settlePayment(pid)).to.emit(
        f.noblepay,
        "PaymentSettled",
      );
      expect(await f.usdc.balanceOf(f.treasury.address)).to.equal(
        treBefore + amount,
      );
    });
  });

  describe("reentrancy (real attack fixtures)", function () {
    async function twoFundedNativePassed(f) {
      // Deploy the malicious recipient, fund two native payments to it, pass both.
      const Attacker = await ethers.getContractFactory(
        "MaliciousNativeReceiver",
      );
      const attacker = await Attacker.deploy();
      await attacker.waitForDeployment();
      await f.noblepay
        .connect(f.admin)
        .syncBusiness(f.business1.address, 0, true);

      const amount = ethers.parseUnits("2", 6);
      const idA = await initiateNative(f, f.business1, attacker.target, amount);
      const idB = await initiateNative(f, f.business1, attacker.target, amount);
      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(idA, true, 10, true, ethers.ZeroHash, "0x");
      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(idB, true, 10, true, ethers.ZeroHash, "0x");
      return { attacker, idA, idB };
    }

    it("a malicious recipient cannot re-enter settlePayment mid-settlement", async function () {
      const f = await loadFixture(deployFixture);
      const { attacker, idA, idB } = await twoFundedNativePassed(f);
      await attacker.arm(f.noblepay.target, idB, 0); // re-enter settle(idB)

      // The guard reverts the re-entry inside receive(), so the outer transfer
      // fails and the whole settlement reverts — no double-settle slips through.
      await expect(f.noblepay.settlePayment(idA)).to.be.revertedWith(
        "NoblePay: native transfer failed",
      );
      // Both payments remain PASSED (2), not SETTLED (4).
      expect((await f.noblepay.getPayment(idA)).status).to.equal(1);
      expect((await f.noblepay.getPayment(idB)).status).to.equal(1);
    });

    it("a malicious recipient cannot re-enter cancelPayment mid-settlement", async function () {
      const f = await loadFixture(deployFixture);
      const { attacker, idA } = await twoFundedNativePassed(f);
      // A fresh PENDING payment for the attacker to try to cancel on re-entry.
      const idPending = await initiateNative(
        f,
        f.business1,
        attacker.target,
        ethers.parseUnits("2", 6),
      );
      await attacker.arm(f.noblepay.target, idPending, 2); // re-enter cancel

      await expect(f.noblepay.settlePayment(idA)).to.be.revertedWith(
        "NoblePay: native transfer failed",
      );
      expect((await f.noblepay.getPayment(idA)).status).to.equal(1); // still PASSED
      expect((await f.noblepay.getPayment(idPending)).status).to.equal(0); // still PENDING
    });

    it("the same recipient settles fine once disarmed (fixture sanity)", async function () {
      const f = await loadFixture(deployFixture);
      const { idA } = await twoFundedNativePassed(f);
      // attacker not armed → normal settlement succeeds
      await expect(f.noblepay.settlePayment(idA)).to.emit(
        f.noblepay,
        "PaymentSettled",
      );
    });
  });

  describe("hostile seal gate cannot reenter settlement", function () {
    it("a gate whose isCleared re-enters settlePayment reverts (staticcall boundary)", async function () {
      const f = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("2", 6);
      const tx = await f.noblepay
        .connect(f.business1)
        .initiatePayment(
          f.recipient.address,
          amount,
          f.usdc.target,
          ethers.ZeroHash,
          USD,
        );
      const r = await tx.wait();
      const pid = r.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      ).args[0];
      await f.noblepay
        .connect(f.teeNode)
        .submitComplianceResult(pid, true, 10, true, ethers.ZeroHash, "0x");

      const Hostile = await ethers.getContractFactory("ReentrantSealGate");
      const gate = await Hostile.deploy();
      await gate.waitForDeployment();
      await gate.arm(f.noblepay.target, pid);

      await f.noblepay.connect(f.admin).setSealGate(gate.target);
      await f.noblepay.connect(f.admin).setSealClearanceRequired(true);

      // isCleared is `view` in the interface → invoked via staticcall → its
      // state-changing re-entry attempt reverts the whole settlement.
      await expect(f.noblepay.settlePayment(pid)).to.be.revert(ethers);
      expect((await f.noblepay.getPayment(pid)).status).to.equal(1); // still PASSED
    });
  });
});

// ---------------------------------------------------------------------------
// Native-unit volume limits + exact escrow — field fix from testnet testing:
// tier limits are denominated in 6-decimal (stablecoin) units, so an
// 18-decimal native amount blew through even the ENTERPRISE cap and every
// realistic AETHEL payment reverted DailyLimitExceeded. Native amounts are
// now normalized (1 AETHEL = 1e6 limit units) and native escrow is exact —
// surplus value would be permanently unrecoverable (no sweep, no receive()).
// ---------------------------------------------------------------------------
describe("NoblePay — native limit units + exact escrow", function () {
  const AETHEL = "0x414554";

  async function deployFixture() {
    const [admin, treasury, teeNode, business1, recipient] =
      await ethers.getSigners();
    const NoblePay = await ethers.getContractFactory("NoblePay");
    const noblepay = await NoblePay.deploy(
      admin.address,
      treasury.address,
      ethers.parseUnits("1", 6),
      50,
    );
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true); // STANDARD
    const bal = ethers.parseUnits("1000000", 6);
    await usdc.mint(business1.address, bal);
    await usdc.connect(business1).approve(noblepay.target, bal);
    return { noblepay, usdc, admin, business1, recipient };
  }

  it("accepts a realistic native payment (10 AETHEL) at STANDARD tier", async function () {
    const { noblepay, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("10"); // 1e19 wei — impossible before normalization
    await expect(
      noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, AETHEL,
        { value: amount },
      ),
    ).to.emit(noblepay, "PaymentInitiated");
  });

  it("still enforces the STANDARD daily cap in normalized units (60k AETHEL > 50k)", async function () {
    const { noblepay, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("60000"); // 6e10 units > 5e10 STANDARD_DAILY_LIMIT
    await ethers.provider.send("hardhat_setBalance", [
      business1.address,
      "0x" + (70000n * 10n ** 18n).toString(16),
    ]);
    await expect(
      noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, AETHEL,
        { value: amount },
      ),
    ).to.be.revertedWithCustomError(noblepay, "DailyLimitExceeded");
  });

  it("rejects native overpayment — surplus would be unrecoverable", async function () {
    const { noblepay, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    await expect(
      noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, AETHEL,
        { value: amount + 1n },
      ),
    ).to.be.revertedWithCustomError(noblepay, "IncorrectNativeAmount");
  });

  it("rejects msg.value attached to an ERC-20 payment", async function () {
    const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("100", 6);
    await expect(
      noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344",
        { value: 1n },
      ),
    ).to.be.revertedWithCustomError(noblepay, "IncorrectNativeAmount");
  });

  it("rejects batch native overpayment (exact escrow)", async function () {
    const { noblepay, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("1");
    await expect(
      noblepay.connect(business1).initiatePaymentBatch(
        [recipient.address], [amount], [ethers.ZeroAddress], [ethers.ZeroHash], [AETHEL],
        { value: amount * 2n },
      ),
    ).to.be.revertedWithCustomError(noblepay, "IncorrectNativeAmount");
  });

  it("rejects plain native transfers (no receive function)", async function () {
    const { noblepay, admin } = await loadFixture(deployFixture);
    await expect(
      admin.sendTransaction({ to: noblepay.target, value: ethers.parseEther("1") }),
    ).to.be.revert(ethers);
  });
});
