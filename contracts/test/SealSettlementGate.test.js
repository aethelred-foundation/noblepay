import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();

/**
 * SealSettlementGate — consensus-anchored corridor clearance.
 *
 * The ISeal precompile lives at a fixed address (0x0900) on Aethelred, so the
 * suite installs MockISeal's runtime bytecode there with setCode. NOTE:
 * setCode wipes storage — mock seals must be (re)populated AFTER the code is
 * installed. The REAL precompile binding (real seal keeper, vendored bytecode,
 * live revocation) is proven in the aethelred repo's evmhost test.
 */
describe("SealSettlementGate", function () {
  const SEAL_PRECOMPILE = "0x0000000000000000000000000000000000000900";
  const JOB = "job-screen-001";
  const SEAL_ID = "a".repeat(64);

  const purposeFor = (payer, payee) =>
    `noblepay:${payer.toLowerCase()}:${payee.toLowerCase()}`;

  async function deployFixture() {
    const [governance, payer, payee, stranger] = await ethers.getSigners();

    // Install MockISeal's runtime bytecode at the precompile address.
    const MockISeal = await ethers.getContractFactory("MockISeal");
    const deployed = await MockISeal.deploy();
    await deployed.waitForDeployment();
    const runtime = await ethers.provider.getCode(deployed.target);
    await networkHelpers.setCode(SEAL_PRECOMPILE, runtime);
    const seal = MockISeal.attach(SEAL_PRECOMPILE);

    // setCode wiped storage — set mock state afterwards.
    await seal.setPolicyResult(true, "");

    const Gate = await ethers.getContractFactory("SealSettlementGate");
    const gate = await Gate.deploy(governance.address);
    await gate.waitForDeployment();

    return { gate, seal, governance, payer, payee, stranger };
  }

  async function mintSeal(
    seal,
    payer,
    payee,
    { job = JOB, sealId = SEAL_ID, active = true } = {},
  ) {
    await seal.setSeal(
      job,
      sealId,
      purposeFor(payer.address, payee.address),
      active,
    );
  }

  describe("clearing", function () {
    it("clears a corridor backed by a bound, active, policy-satisfying seal", async function () {
      const { gate, seal, payer, payee, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      expect(await gate.isCleared(payer.address, payee.address)).to.equal(
        false,
      );

      await expect(
        gate.connect(stranger).clear(payer.address, payee.address, JOB),
      )
        .to.emit(gate, "CorridorCleared")
        .withArgs(payer.address, payee.address, SEAL_ID, JOB);

      expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);
      const record = await gate.getClearance(payer.address, payee.address);
      expect(record.sealId).to.equal(SEAL_ID);
      expect(record.exists).to.equal(true);
      expect(record.revoked).to.equal(false);
    });

    it("clearance is direction-sensitive: payer→payee does not clear payee→payer", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);

      expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);
      expect(await gate.isCleared(payee.address, payer.address)).to.equal(
        false,
      );
    });

    it("rejects a seal bound to a different corridor", async function () {
      const { gate, seal, payer, payee, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      // Seal bound to (payer → stranger), presented for (payer → payee).
      await mintSeal(seal, payer, stranger);
      await expect(
        gate.clear(payer.address, payee.address, JOB),
      ).to.be.revertedWithCustomError(gate, "SealNotBoundToCorridor");
    });

    it("rejects a reversed-direction seal (payee→payer seal cannot clear payer→payee)", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payee, payer); // reversed binding
      await expect(
        gate.clear(payer.address, payee.address, JOB),
      ).to.be.revertedWithCustomError(gate, "SealNotBoundToCorridor");
    });

    it("rejects a seal that fails the CEAP compliance policy", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await seal.setPolicyResult(false, "jurisdiction not allowed");
      await expect(gate.clear(payer.address, payee.address, JOB))
        .to.be.revertedWithCustomError(gate, "PolicyNotSatisfied")
        .withArgs("jurisdiction not allowed");
    });

    it("rejects an inactive (revoked/expired) seal", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee, { active: false });
      await expect(
        gate.clear(payer.address, payee.address, JOB),
      ).to.be.revertedWithCustomError(gate, "SealNotActive");
    });

    it("rejects seal replay across corridors (one seal, one clearance)", async function () {
      const { gate, seal, payer, payee, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);

      // Same seal presented for a second corridor via another job mapping.
      await seal.setSeal(
        "job-screen-002",
        SEAL_ID,
        purposeFor(payer.address, stranger.address),
        true,
      );
      await expect(
        gate.clear(payer.address, stranger.address, "job-screen-002"),
      ).to.be.revertedWithCustomError(gate, "SealAlreadyUsed");
    });

    it("rejects zero-address corridor endpoints", async function () {
      const { gate, payer } = await networkHelpers.loadFixture(deployFixture);
      await expect(
        gate.clear(ethers.ZeroAddress, payer.address, JOB),
      ).to.be.revertedWithCustomError(gate, "ZeroCorridor");
      await expect(
        gate.clear(payer.address, ethers.ZeroAddress, JOB),
      ).to.be.revertedWithCustomError(gate, "ZeroCorridor");
    });

    it("one corridor, one clearance: a live clearance cannot be overwritten", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);
      const before = await gate.getClearance(payer.address, payee.address);

      await seal.setSeal(
        "job-screen-dup",
        "c".repeat(64),
        purposeFor(payer.address, payee.address),
        true,
      );
      await expect(gate.clear(payer.address, payee.address, "job-screen-dup"))
        .to.be.revertedWithCustomError(gate, "AlreadyCleared")
        .withArgs(payer.address, payee.address);

      const after = await gate.getClearance(payer.address, payee.address);
      expect(after.sealId).to.equal(before.sealId);
      expect(after.clearedAt).to.equal(before.clearedAt);
    });

    it("SECURITY: a governance revocation cannot be undone by re-clearing with a fresh seal", async function () {
      const { gate, seal, governance, payer, payee, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);
      await gate.connect(governance).revoke(payer.address, payee.address);
      expect(await gate.isCleared(payer.address, payee.address)).to.equal(
        false,
      );

      // Attacker holds a second, legitimately corridor-bound ACTIVE seal.
      // Without the AlreadyCleared guard this would rewrite revoked=false,
      // reopening a corridor governance closed — through a permissionless call.
      await seal.setSeal(
        "job-screen-fresh",
        "d".repeat(64),
        purposeFor(payer.address, payee.address),
        true,
      );
      await expect(
        gate
          .connect(stranger)
          .clear(payer.address, payee.address, "job-screen-fresh"),
      ).to.be.revertedWithCustomError(gate, "AlreadyCleared");

      expect(await gate.isCleared(payer.address, payee.address)).to.equal(
        false,
      );
      const record = await gate.getClearance(payer.address, payee.address);
      expect(record.revoked).to.equal(true);
    });
  });

  describe("live consensus revocation", function () {
    it("a corridor closes the moment the chain revokes the seal — no NoblePay tx", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);
      expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);

      await seal.setActive(SEAL_ID, false); // consensus-side revocation
      expect(await gate.isCleared(payer.address, payee.address)).to.equal(
        false,
      );
      await expect(
        gate.requireCleared(payer.address, payee.address),
      ).to.be.revertedWithCustomError(gate, "NoSuchClearance");
    });
  });

  describe("local revocation", function () {
    it("governance can revoke a clearance", async function () {
      const { gate, seal, governance, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);

      await expect(
        gate.connect(governance).revoke(payer.address, payee.address),
      )
        .to.emit(gate, "ClearanceRevoked")
        .withArgs(payer.address, payee.address, governance.address);
      expect(await gate.isCleared(payer.address, payee.address)).to.equal(
        false,
      );
    });

    it("non-owner cannot revoke", async function () {
      const { gate, seal, payer, payee, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);
      await expect(
        gate.connect(stranger).revoke(payer.address, payee.address),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("revoking a non-existent clearance reverts", async function () {
      const { gate, governance, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await expect(
        gate.connect(governance).revoke(payer.address, payee.address),
      ).to.be.revertedWithCustomError(gate, "NoSuchClearance");
    });
  });

  describe("governance", function () {
    it("only owner can set the compliance policy", async function () {
      const { gate, governance, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await expect(
        gate
          .connect(stranger)
          .setCompliancePolicy(["tee"], "", [], false, ["AE"]),
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await gate
        .connect(governance)
        .setCompliancePolicy(["tee"], "", [], false, ["AE"]);
      const policy = await gate.compliancePolicy();
      expect(policy[0]).to.deep.equal(["tee"]);
      expect(policy[4]).to.deep.equal(["AE"]);
    });

    it("ownership transfer is two-step; non-pending acceptor rejected", async function () {
      const { gate, governance, payer, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await gate.connect(governance).transferOwnership(payer.address);
      expect(await gate.owner()).to.equal(governance.address); // not yet

      await expect(gate.connect(stranger).acceptOwnership()).to.be.revertedWith(
        "Ownable2Step: caller is not the new owner",
      );
      await gate.connect(payer).acceptOwnership();
      expect(await gate.owner()).to.equal(payer.address);
    });

    it("pause blocks clearing but verification reads stay live; owner-only both ways", async function () {
      const { gate, seal, governance, payer, payee, stranger } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);

      await expect(gate.connect(stranger).pause()).to.be.revertedWith(
        "Ownable: caller is not the owner",
      );
      await gate.connect(governance).pause();

      await seal.setSeal(
        "job-screen-003",
        "b".repeat(64),
        purposeFor(payee.address, payer.address),
        true,
      );
      await expect(
        gate.clear(payee.address, payer.address, "job-screen-003"),
      ).to.be.revertedWith("Pausable: paused");

      // Reads unaffected while paused.
      expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);

      await expect(gate.connect(stranger).unpause()).to.be.revertedWith(
        "Ownable: caller is not the owner",
      );
      await gate.connect(governance).unpause();
      // Succeeds after unpause (an unexpected revert would fail the test).
      await gate.clear(payee.address, payer.address, "job-screen-003");
    });
  });

  describe("helpers", function () {
    it("expectedPurpose returns the canonical corridor binding string", async function () {
      const { gate, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      expect(await gate.expectedPurpose(payer.address, payee.address)).to.equal(
        purposeFor(payer.address, payee.address),
      );
    });

    it("requireCleared passes silently for a live clearance (hard-gate success path)", async function () {
      const { gate, seal, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      await mintSeal(seal, payer, payee);
      await gate.clear(payer.address, payee.address, JOB);
      // A revert here would fail the test — this is the success path.
      await gate.requireCleared(payer.address, payee.address);
    });

    it("getClearance on an unknown corridor returns an empty record", async function () {
      const { gate, payer, payee } =
        await networkHelpers.loadFixture(deployFixture);
      const record = await gate.getClearance(payer.address, payee.address);
      expect(record.exists).to.equal(false);
      expect(record.revoked).to.equal(false);
      expect(record.sealId).to.equal("");
      expect(record.clearedAt).to.equal(0);
    });

    it("compliancePolicy starts empty (any backend/jurisdiction) until governance sets it", async function () {
      const { gate } = await networkHelpers.loadFixture(deployFixture);
      const policy = await gate.compliancePolicy();
      expect(policy[0]).to.deep.equal([]);
      expect(policy[1]).to.equal("");
      expect(policy[2]).to.deep.equal([]);
      expect(policy[3]).to.equal(false);
      expect(policy[4]).to.deep.equal([]);
    });
  });
});
