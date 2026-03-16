const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("TravelRule", function () {
  async function deployFixture() {
    const [admin, teeNode, vasp1, vasp2, other] = await ethers.getSigners();

    const TravelRule = await ethers.getContractFactory("TravelRule");
    const travelRule = await TravelRule.deploy(admin.address);

    const TEE_NODE_ROLE = await travelRule.TEE_NODE_ROLE();
    await travelRule.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);

    // Register VASPs
    const instHash1 = ethers.keccak256(ethers.toUtf8Bytes("VASP-1"));
    const instHash2 = ethers.keccak256(ethers.toUtf8Bytes("VASP-2"));
    const pubKey = ethers.toUtf8Bytes("encryption-public-key");
    await travelRule.connect(vasp1).registerVASP(instHash1, pubKey);
    await travelRule.connect(vasp2).registerVASP(instHash2, pubKey);

    return { travelRule, admin, teeNode, vasp1, vasp2, other, TEE_NODE_ROLE };
  }

  function makeSubmitParams(originator, beneficiary) {
    return {
      paymentId: ethers.keccak256(ethers.toUtf8Bytes("payment-1")),
      originatorNameHash: ethers.keccak256(ethers.toUtf8Bytes("Alice")),
      originatorAddress: originator,
      originatorInstitution: ethers.keccak256(ethers.toUtf8Bytes("VASP-1")),
      beneficiaryNameHash: ethers.keccak256(ethers.toUtf8Bytes("Bob")),
      beneficiaryAddress: beneficiary,
      beneficiaryInstitution: ethers.keccak256(ethers.toUtf8Bytes("VASP-2")),
      amount: 5000n * 1000000n, // $5000
      currency: "0x555344", // USD
      encryptedDataHash: ethers.keccak256(ethers.toUtf8Bytes("encrypted-data")),
    };
  }

  async function submittedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { travelRule, teeNode, vasp1, vasp2 } = fixture;
    const params = makeSubmitParams(vasp1.address, vasp2.address);
    const tx = await travelRule.connect(teeNode).submitTravelRuleData(
      params.paymentId, params.originatorNameHash, params.originatorAddress,
      params.originatorInstitution, params.beneficiaryNameHash, params.beneficiaryAddress,
      params.beneficiaryInstitution, params.amount, params.currency, params.encryptedDataHash
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TravelRuleDataSubmitted");
    const travelRuleId = event.args[0];
    return { ...fixture, travelRuleId, params };
  }

  async function verifiedFixture() {
    const fixture = await submittedFixture();
    const { travelRule, teeNode, travelRuleId } = fixture;
    await travelRule.connect(teeNode).verifyTravelRuleCompliance(travelRuleId);
    return fixture;
  }

  describe("Deployment", function () {
    it("should set admin and default threshold", async function () {
      const { travelRule } = await loadFixture(deployFixture);
      expect(await travelRule.travelRuleThreshold()).to.equal(1000n * 1000000n);
    });

    it("should revert with zero admin", async function () {
      const TravelRule = await ethers.getContractFactory("TravelRule");
      await expect(TravelRule.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(TravelRule, "ZeroAddress");
    });
  });

  describe("VASP Registration", function () {
    it("should register a VASP", async function () {
      const { travelRule, other } = await loadFixture(deployFixture);
      const instHash = ethers.keccak256(ethers.toUtf8Bytes("New-VASP"));
      const pubKey = ethers.toUtf8Bytes("key-data");
      await expect(travelRule.connect(other).registerVASP(instHash, pubKey))
        .to.emit(travelRule, "VASPRegistered");
    });

    it("should revert duplicate VASP", async function () {
      const { travelRule, vasp1 } = await loadFixture(deployFixture);
      const instHash = ethers.keccak256(ethers.toUtf8Bytes("dup"));
      await expect(travelRule.connect(vasp1).registerVASP(instHash, ethers.toUtf8Bytes("k")))
        .to.be.revertedWithCustomError(travelRule, "VASPAlreadyRegistered");
    });

    it("should revert with empty public key", async function () {
      const { travelRule, other } = await loadFixture(deployFixture);
      const instHash = ethers.keccak256(ethers.toUtf8Bytes("X"));
      await expect(travelRule.connect(other).registerVASP(instHash, "0x"))
        .to.be.revertedWith("TravelRule: empty public key");
    });

    it("should deactivate a VASP", async function () {
      const { travelRule, admin, vasp1 } = await loadFixture(deployFixture);
      await expect(travelRule.connect(admin).deactivateVASP(vasp1.address))
        .to.emit(travelRule, "VASPDeactivated");
      const details = await travelRule.getVASPDetails(vasp1.address);
      expect(details.active).to.be.false;
    });

    it("should revert deactivate for non-existent VASP", async function () {
      const { travelRule, admin, other } = await loadFixture(deployFixture);
      await expect(travelRule.connect(admin).deactivateVASP(other.address))
        .to.be.revertedWithCustomError(travelRule, "VASPNotFound");
    });
  });

  describe("Travel Rule Data Submission", function () {
    it("should submit travel rule data", async function () {
      const { travelRule, teeNode, vasp1, vasp2 } = await loadFixture(deployFixture);
      const params = makeSubmitParams(vasp1.address, vasp2.address);
      await expect(travelRule.connect(teeNode).submitTravelRuleData(
        params.paymentId, params.originatorNameHash, params.originatorAddress,
        params.originatorInstitution, params.beneficiaryNameHash, params.beneficiaryAddress,
        params.beneficiaryInstitution, params.amount, params.currency, params.encryptedDataHash
      )).to.emit(travelRule, "TravelRuleDataSubmitted");
      expect(await travelRule.totalSubmissions()).to.equal(1);
    });

    it("should revert for non-TEE node", async function () {
      const { travelRule, other, vasp1, vasp2 } = await loadFixture(deployFixture);
      const params = makeSubmitParams(vasp1.address, vasp2.address);
      await expect(travelRule.connect(other).submitTravelRuleData(
        params.paymentId, params.originatorNameHash, params.originatorAddress,
        params.originatorInstitution, params.beneficiaryNameHash, params.beneficiaryAddress,
        params.beneficiaryInstitution, params.amount, params.currency, params.encryptedDataHash
      )).to.be.reverted;
    });

    it("should revert for zero originator address", async function () {
      const { travelRule, teeNode, vasp2 } = await loadFixture(deployFixture);
      const params = makeSubmitParams(ethers.ZeroAddress, vasp2.address);
      await expect(travelRule.connect(teeNode).submitTravelRuleData(
        params.paymentId, params.originatorNameHash, params.originatorAddress,
        params.originatorInstitution, params.beneficiaryNameHash, params.beneficiaryAddress,
        params.beneficiaryInstitution, params.amount, params.currency, params.encryptedDataHash
      )).to.be.revertedWithCustomError(travelRule, "ZeroAddress");
    });

    it("should revert for zero amount", async function () {
      const { travelRule, teeNode, vasp1, vasp2 } = await loadFixture(deployFixture);
      const params = makeSubmitParams(vasp1.address, vasp2.address);
      await expect(travelRule.connect(teeNode).submitTravelRuleData(
        params.paymentId, params.originatorNameHash, params.originatorAddress,
        params.originatorInstitution, params.beneficiaryNameHash, params.beneficiaryAddress,
        params.beneficiaryInstitution, 0, params.currency, params.encryptedDataHash
      )).to.be.revertedWithCustomError(travelRule, "ZeroAmount");
    });

    it("should revert for duplicate payment submission", async function () {
      const { travelRule, teeNode, params } = await submittedFixture();
      await expect(travelRule.connect(teeNode).submitTravelRuleData(
        params.paymentId, params.originatorNameHash, params.originatorAddress,
        params.originatorInstitution, params.beneficiaryNameHash, params.beneficiaryAddress,
        params.beneficiaryInstitution, params.amount, params.currency, params.encryptedDataHash
      )).to.be.revertedWithCustomError(travelRule, "DuplicateSubmission");
    });
  });

  describe("Verification & Rejection", function () {
    it("should verify travel rule data", async function () {
      const { travelRule, teeNode, travelRuleId } = await submittedFixture();
      await expect(travelRule.connect(teeNode).verifyTravelRuleCompliance(travelRuleId))
        .to.emit(travelRule, "TravelRuleVerified");
      expect(await travelRule.getTravelRuleStatus(travelRuleId)).to.equal(1); // VERIFIED
    });

    it("should reject travel rule data", async function () {
      const { travelRule, teeNode, travelRuleId } = await submittedFixture();
      await expect(travelRule.connect(teeNode).rejectTravelRuleData(travelRuleId, "incomplete data"))
        .to.emit(travelRule, "TravelRuleRejected");
      expect(await travelRule.getTravelRuleStatus(travelRuleId)).to.equal(2); // REJECTED
    });

    it("should revert verify on non-pending record", async function () {
      const { travelRule, teeNode, travelRuleId } = await verifiedFixture();
      await expect(travelRule.connect(teeNode).verifyTravelRuleCompliance(travelRuleId))
        .to.be.revertedWithCustomError(travelRule, "InvalidStatus");
    });

    it("should revert for non-existent record", async function () {
      const { travelRule, teeNode } = await loadFixture(deployFixture);
      await expect(travelRule.connect(teeNode).verifyTravelRuleCompliance(ethers.ZeroHash))
        .to.be.revertedWithCustomError(travelRule, "RecordNotFound");
    });
  });

  describe("Inter-VASP Sharing", function () {
    it("should share verified data with beneficiary VASP", async function () {
      const { travelRule, vasp1, vasp2, travelRuleId } = await verifiedFixture();
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("shared-payload"));
      await expect(travelRule.connect(vasp1).shareWithReceivingInstitution(travelRuleId, vasp2.address, dataHash))
        .to.emit(travelRule, "TravelRuleShared");
    });

    it("should revert sharing non-verified data", async function () {
      const { travelRule, vasp1, vasp2, travelRuleId } = await submittedFixture();
      await expect(travelRule.connect(vasp1).shareWithReceivingInstitution(travelRuleId, vasp2.address, ethers.ZeroHash))
        .to.be.revertedWithCustomError(travelRule, "InvalidStatus");
    });

    it("should revert sharing to inactive VASP", async function () {
      const { travelRule, admin, vasp1, vasp2, travelRuleId } = await verifiedFixture();
      await travelRule.connect(admin).deactivateVASP(vasp2.address);
      await expect(travelRule.connect(vasp1).shareWithReceivingInstitution(travelRuleId, vasp2.address, ethers.ZeroHash))
        .to.be.revertedWithCustomError(travelRule, "VASPNotActive");
    });
  });

  describe("Acknowledgement", function () {
    async function sharedFixture() {
      const fixture = await verifiedFixture();
      const { travelRule, vasp1, vasp2, travelRuleId } = fixture;
      const dataHash = ethers.keccak256(ethers.toUtf8Bytes("shared"));
      const tx = await travelRule.connect(vasp1).shareWithReceivingInstitution(travelRuleId, vasp2.address, dataHash);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TravelRuleShared");
      const sharingId = event.args[1];
      return { ...fixture, sharingId };
    }

    it("should acknowledge shared data", async function () {
      const { travelRule, vasp2, sharingId } = await sharedFixture();
      await expect(travelRule.connect(vasp2).acknowledgeTravelRuleData(sharingId))
        .to.emit(travelRule, "TravelRuleAcknowledged");
    });

    it("should revert double acknowledgement", async function () {
      const { travelRule, vasp2, sharingId } = await sharedFixture();
      await travelRule.connect(vasp2).acknowledgeTravelRuleData(sharingId);
      await expect(travelRule.connect(vasp2).acknowledgeTravelRuleData(sharingId))
        .to.be.revertedWithCustomError(travelRule, "AlreadyAcknowledged");
    });

    it("should revert acknowledgement by wrong VASP", async function () {
      const { travelRule, vasp1, sharingId } = await sharedFixture();
      await expect(travelRule.connect(vasp1).acknowledgeTravelRuleData(sharingId))
        .to.be.revertedWith("TravelRule: not the beneficiary VASP");
    });

    it("should revert after deadline", async function () {
      const { travelRule, vasp2, sharingId } = await sharedFixture();
      await time.increase(49 * 60 * 60); // > 48 hours
      await expect(travelRule.connect(vasp2).acknowledgeTravelRuleData(sharingId))
        .to.be.revertedWithCustomError(travelRule, "AcknowledgementDeadlinePassed");
    });
  });

  describe("View Functions", function () {
    it("should check threshold requirement", async function () {
      const { travelRule } = await loadFixture(deployFixture);
      expect(await travelRule.requiresFullTravelRuleData(999n * 1000000n)).to.be.false;
      expect(await travelRule.requiresFullTravelRuleData(1000n * 1000000n)).to.be.true;
    });

    it("should check record expiry", async function () {
      const { travelRule, travelRuleId } = await submittedFixture();
      expect(await travelRule.isRecordExpired(travelRuleId)).to.be.false;
      await time.increase(5 * 365 * 24 * 60 * 60 + 1);
      expect(await travelRule.isRecordExpired(travelRuleId)).to.be.true;
    });
  });

  describe("Admin", function () {
    it("should update threshold", async function () {
      const { travelRule, admin } = await loadFixture(deployFixture);
      await expect(travelRule.connect(admin).updateThreshold(2000n * 1000000n))
        .to.emit(travelRule, "ThresholdUpdated");
      expect(await travelRule.travelRuleThreshold()).to.equal(2000n * 1000000n);
    });

    it("should revert zero threshold", async function () {
      const { travelRule, admin } = await loadFixture(deployFixture);
      await expect(travelRule.connect(admin).updateThreshold(0))
        .to.be.revertedWith("TravelRule: zero threshold");
    });

    it("should pause and unpause", async function () {
      const { travelRule, admin } = await loadFixture(deployFixture);
      await travelRule.connect(admin).pause();
      expect(await travelRule.paused()).to.be.true;
      await travelRule.connect(admin).unpause();
      expect(await travelRule.paused()).to.be.false;
    });
  });
});
