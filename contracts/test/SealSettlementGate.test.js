const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * SealSettlementGate unit suite — mirrors the behaviour the chain repo proves
 * against the REAL ISeal precompile in internal/evmhost/noblepay_test.go:
 * corridor-direction sensitivity, CEAP policy enforcement, live revocation, and
 * clearance permanence. Here the precompile is a MockISeal installed at 0x0900
 * via hardhat_setCode; the real-precompile binding is the chain repo's job.
 */
const SEAL_ADDR = "0x0000000000000000000000000000000000000900";

describe("SealSettlementGate", function () {
  let gov, payer, payee, other, stranger;
  let gate, seal;

  beforeEach(async function () {
    [gov, payer, payee, other, stranger] = await ethers.getSigners();

    const Gate = await ethers.getContractFactory("SealSettlementGate");
    gate = await Gate.deploy(gov.address);
    await gate.waitForDeployment();

    // Install the mock precompile's runtime code at 0x0900. hardhat_setCode
    // zeroes the target's storage AND does not run the constructor, so the
    // `_policyOk = true` initializer does NOT apply — set the baseline explicitly.
    const Mock = await ethers.getContractFactory("MockISeal");
    const impl = await Mock.deploy();
    await impl.waitForDeployment();
    const code = await ethers.provider.getCode(await impl.getAddress());
    await ethers.provider.send("hardhat_setCode", [SEAL_ADDR, code]);
    seal = await ethers.getContractAt("MockISeal", SEAL_ADDR);
    await seal.setPolicyResult(true, "");

    // Governance CEAP policy: TEE backend, UAE residency.
    await gate.connect(gov).setCompliancePolicy(["tee"], "", [], false, ["AE"]);
  });

  async function seedCorridorSeal(jobId, sealId, p, q, active = true) {
    const purpose = await gate.expectedPurpose(p.address, q.address);
    await seal.setSeal(jobId, sealId, purpose, active);
  }

  it("sets and reads back the CEAP policy", async function () {
    const [backends, minVerif, platforms, vendorRoot, residency] = await gate.compliancePolicy();
    expect(backends).to.deep.equal(["tee"]);
    expect(minVerif).to.equal("");
    expect(platforms).to.deep.equal([]);
    expect(vendorRoot).to.equal(false);
    expect(residency).to.deep.equal(["AE"]);
  });

  it("corridor is closed before any seal exists", async function () {
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(false);
  });

  it("clears a corridor backed by a policy-satisfying, corridor-bound seal", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    // Permissionless: the payee (a third party to governance) clears it.
    await expect(gate.connect(payee).clear(payer.address, payee.address, "job-1"))
      .to.emit(gate, "CorridorCleared")
      .withArgs(payer.address, payee.address, "seal-1", "job-1");
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);
    expect(await gate.sealUsed("seal-1")).to.equal(true);

    const c = await gate.getClearance(payer.address, payee.address);
    expect(c.sealId).to.equal("seal-1");
    expect(c.exists).to.equal(true);
    expect(c.revoked).to.equal(false);
  });

  it("is direction-sensitive: a payer->payee seal does not clear payee->payer", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await gate.connect(payee).clear(payer.address, payee.address, "job-1");
    expect(await gate.isCleared(payee.address, payer.address)).to.equal(false);
  });

  it("rejects a seal whose purpose does not bind the corridor", async function () {
    // Seal minted for payer->other, presented for payer->payee.
    await seedCorridorSeal("job-x", "seal-x", payer, other);
    const expected = await gate.expectedPurpose(payer.address, payee.address);
    await expect(gate.clear(payer.address, payee.address, "job-x"))
      .to.be.revertedWithCustomError(gate, "SealNotBoundToCorridor")
      .withArgs(expected);
  });

  it("rejects a seal that fails the CEAP policy (e.g. US residency vs AE)", async function () {
    await seedCorridorSeal("job-us", "seal-us", payer, other);
    await seal.setPolicyResult(false, "data residency US not in [AE]");
    await expect(gate.clear(payer.address, other.address, "job-us"))
      .to.be.revertedWithCustomError(gate, "PolicyNotSatisfied")
      .withArgs("data residency US not in [AE]");
  });

  it("rejects an inactive (pending/revoked) seal", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee, false);
    await expect(gate.clear(payer.address, payee.address, "job-1"))
      .to.be.revertedWithCustomError(gate, "SealNotActive")
      .withArgs("seal-1");
  });

  it("admits each seal exactly once (replay protection)", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await gate.clear(payer.address, payee.address, "job-1");
    // Re-point a fresh corridor's job at the already-used seal id.
    await seedCorridorSeal("job-2", "seal-1", payer, other);
    await expect(gate.clear(payer.address, other.address, "job-2"))
      .to.be.revertedWithCustomError(gate, "SealAlreadyUsed")
      .withArgs("seal-1");
  });

  it("rejects a zero-address corridor", async function () {
    await expect(gate.clear(ethers.ZeroAddress, payee.address, "job-1"))
      .to.be.revertedWithCustomError(gate, "ZeroCorridor");
    await expect(gate.clear(payer.address, ethers.ZeroAddress, "job-1"))
      .to.be.revertedWithCustomError(gate, "ZeroCorridor");
  });

  it("closes the corridor live when the chain revokes the seal", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await gate.clear(payer.address, payee.address, "job-1");
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);

    // Sanctions update: the chain revokes the seal — no NoblePay tx needed.
    await seal.setActive("seal-1", false);
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(false);
  });

  it("clearance permanence: a revoked corridor cannot be re-cleared with a fresh seal", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await gate.clear(payer.address, payee.address, "job-1");
    await seal.setActive("seal-1", false); // revoked on-chain -> isCleared false
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(false);

    // A fresh, active, policy-satisfying, corridor-bound seal must NOT re-open it.
    await seedCorridorSeal("job-3", "seal-3", payer, payee);
    await expect(gate.clear(payer.address, payee.address, "job-3"))
      .to.be.revertedWithCustomError(gate, "AlreadyCleared")
      .withArgs(payer.address, payee.address);
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(false);
  });

  it("requireCleared reverts for an uncleared corridor and passes for a cleared one", async function () {
    await expect(gate.requireCleared(payer.address, payee.address))
      .to.be.revertedWithCustomError(gate, "NoSuchClearance");
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await gate.clear(payer.address, payee.address, "job-1");
    await gate.requireCleared(payer.address, payee.address); // no revert
  });

  it("governance revoke: only owner, records revocation, closes the corridor", async function () {
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await gate.clear(payer.address, payee.address, "job-1");

    await expect(gate.connect(stranger).revoke(payer.address, payee.address))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(gate.connect(gov).revoke(other.address, stranger.address))
      .to.be.revertedWithCustomError(gate, "NoSuchClearance");

    await expect(gate.connect(gov).revoke(payer.address, payee.address))
      .to.emit(gate, "ClearanceRevoked")
      .withArgs(payer.address, payee.address, gov.address);
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(false);
  });

  it("honours pause / unpause on the clearance path", async function () {
    await gate.connect(gov).pause();
    await seedCorridorSeal("job-1", "seal-1", payer, payee);
    await expect(gate.clear(payer.address, payee.address, "job-1")).to.be.revertedWith(
      "Pausable: paused",
    );
    await gate.connect(gov).unpause();
    await gate.clear(payer.address, payee.address, "job-1");
    expect(await gate.isCleared(payer.address, payee.address)).to.equal(true);
  });

  it("restricts setCompliancePolicy to the owner", async function () {
    await expect(
      gate.connect(stranger).setCompliancePolicy(["fhe"], "", [], false, ["EU"]),
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });
});
