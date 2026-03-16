const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("AIComplianceModule", function () {
  async function deployFixture() {
    const [admin, aiOp, compOfficer, appellant, other] = await ethers.getSigners();

    const AI = await ethers.getContractFactory("AIComplianceModule");
    const ai = await AI.deploy(admin.address);

    // Grant roles
    await ai.connect(admin).grantRole(await ai.AI_OPERATOR_ROLE(), aiOp.address);
    await ai.connect(admin).grantRole(await ai.COMPLIANCE_OFFICER_ROLE(), compOfficer.address);

    // Register a model
    const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model_artifact_v1"));
    const tx = await ai.connect(aiOp).registerModel("AML-Detector", "1.0.0", modelHash);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ModelRegistered");
    const modelId = event.args[0];

    return { ai, admin, aiOp, compOfficer, appellant, other, modelId, modelHash };
  }

  const subjectHash = ethers.keccak256(ethers.toUtf8Bytes("tx_12345"));
  const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence_doc"));
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("decision_reason"));

  async function decisionRecordedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { ai, aiOp, modelId } = fixture;
    const tx = await ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 85, evidenceHash, reasonHash); // APPROVED, 85% confidence
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
    const decisionId = event.args[0];
    return { ...fixture, decisionId };
  }

  async function appealFiledFixture() {
    const fixture = await decisionRecordedFixture();
    const { ai, appellant, decisionId } = fixture;
    const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("appeal_grounds"));
    const tx = await ai.connect(appellant).fileAppeal(decisionId, groundsHash);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AppealFiled");
    const appealId = event.args[0];
    return { ...fixture, appealId, groundsHash };
  }

  describe("Deployment", function () {
    it("should set admin with all roles", async function () {
      const { ai, admin } = await loadFixture(deployFixture);
      expect(await ai.hasRole(await ai.AI_OPERATOR_ROLE(), admin.address)).to.be.true;
      expect(await ai.hasRole(await ai.COMPLIANCE_OFFICER_ROLE(), admin.address)).to.be.true;
    });

    it("should set default escalation threshold to 60", async function () {
      const { ai } = await loadFixture(deployFixture);
      expect(await ai.escalationThreshold()).to.equal(60);
    });

    it("should revert with zero admin", async function () {
      const AI = await ethers.getContractFactory("AIComplianceModule");
      await expect(AI.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(AI, "ZeroAddress");
    });
  });

  describe("Model Registry", function () {
    it("should register a model", async function () {
      const { ai, aiOp } = await loadFixture(deployFixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("new_model"));
      await expect(ai.connect(aiOp).registerModel("Sanctions-Check", "2.0.0", hash))
        .to.emit(ai, "ModelRegistered");
    });

    it("should revert duplicate model", async function () {
      const { ai, aiOp, modelHash } = await loadFixture(deployFixture);
      await expect(ai.connect(aiOp).registerModel("AML-Detector", "1.0.0", modelHash))
        .to.be.revertedWithCustomError(ai, "ModelAlreadyExists");
    });

    it("should update model status", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      await expect(ai.connect(aiOp).updateModelStatus(modelId, 1)) // DEPRECATED
        .to.emit(ai, "ModelStatusUpdated");
      const model = await ai.getModel(modelId);
      expect(model.status).to.equal(1);
    });

    it("should revert update for non-existent model", async function () {
      const { ai, aiOp } = await loadFixture(deployFixture);
      await expect(ai.connect(aiOp).updateModelStatus(ethers.ZeroHash, 1))
        .to.be.revertedWithCustomError(ai, "ModelNotFound");
    });

    it("should revert register by non-operator", async function () {
      const { ai, other } = await loadFixture(deployFixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("x"));
      await expect(ai.connect(other).registerModel("X", "1.0", hash))
        .to.be.reverted;
    });
  });

  describe("Decision Recording", function () {
    it("should record a decision", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      await expect(ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 85, evidenceHash, reasonHash))
        .to.emit(ai, "DecisionRecorded");
    });

    it("should auto-escalate low confidence decisions", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      const tx = await ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 50, evidenceHash, reasonHash);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      expect(event.args.outcome).to.equal(3); // ESCALATED
      // Should also emit DecisionEscalated
      const escalatedEvent = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionEscalated");
      expect(escalatedEvent).to.not.be.undefined;
    });

    it("should not escalate high confidence decisions", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      const tx = await ai.connect(aiOp).recordDecision(subjectHash, modelId, 1, 80, evidenceHash, reasonHash); // FLAGGED
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
      expect(event.args.outcome).to.equal(1); // FLAGGED (not escalated)
    });

    it("should revert for invalid confidence score", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      await expect(ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 101, evidenceHash, reasonHash))
        .to.be.revertedWithCustomError(ai, "InvalidConfidenceScore");
    });

    it("should revert for non-existent model", async function () {
      const { ai, aiOp } = await loadFixture(deployFixture);
      await expect(ai.connect(aiOp).recordDecision(subjectHash, ethers.ZeroHash, 0, 85, evidenceHash, reasonHash))
        .to.be.revertedWithCustomError(ai, "ModelNotFound");
    });

    it("should revert for inactive model", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      await ai.connect(aiOp).updateModelStatus(modelId, 2); // SUSPENDED
      await expect(ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 85, evidenceHash, reasonHash))
        .to.be.revertedWithCustomError(ai, "ModelNotActive");
    });

    it("should revert for non-operator", async function () {
      const { ai, other, modelId } = await loadFixture(deployFixture);
      await expect(ai.connect(other).recordDecision(subjectHash, modelId, 0, 85, evidenceHash, reasonHash))
        .to.be.reverted;
    });

    it("should increment outcome count", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      await ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 85, evidenceHash, reasonHash);
      expect(await ai.getOutcomeCount(0)).to.equal(1); // APPROVED count
    });
  });

  describe("Appeals", function () {
    it("should file an appeal", async function () {
      const { ai, appellant, decisionId } = await decisionRecordedFixture();
      const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("grounds"));
      await expect(ai.connect(appellant).fileAppeal(decisionId, groundsHash))
        .to.emit(ai, "AppealFiled");
    });

    it("should revert duplicate appeal", async function () {
      const { ai, appellant, decisionId } = await appealFiledFixture();
      const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("grounds2"));
      await expect(ai.connect(appellant).fileAppeal(decisionId, groundsHash))
        .to.be.revertedWithCustomError(ai, "AppealAlreadyFiled");
    });

    it("should revert appeal for non-existent decision", async function () {
      const { ai, appellant } = await loadFixture(deployFixture);
      const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("grounds"));
      await expect(ai.connect(appellant).fileAppeal(ethers.ZeroHash, groundsHash))
        .to.be.revertedWithCustomError(ai, "DecisionNotFound");
    });

    it("should revert appeal after window expired", async function () {
      const { ai, other, decisionId } = await decisionRecordedFixture();
      await time.increase(31 * 86400); // > 30 days
      const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("grounds"));
      await expect(ai.connect(other).fileAppeal(decisionId, groundsHash))
        .to.be.revertedWithCustomError(ai, "AppealWindowExpired");
    });

    it("should start appeal review", async function () {
      const { ai, compOfficer, appealId } = await appealFiledFixture();
      await expect(ai.connect(compOfficer).startAppealReview(appealId))
        .to.emit(ai, "AppealReviewStarted");
    });

    it("should revert start review for non-pending appeal", async function () {
      const { ai, compOfficer, appealId } = await appealFiledFixture();
      await ai.connect(compOfficer).startAppealReview(appealId);
      await expect(ai.connect(compOfficer).startAppealReview(appealId))
        .to.be.revertedWithCustomError(ai, "AppealNotPending");
    });

    it("should resolve appeal as upheld", async function () {
      const { ai, compOfficer, appealId, decisionId } = await appealFiledFixture();
      await ai.connect(compOfficer).startAppealReview(appealId);
      const reviewReason = ethers.keccak256(ethers.toUtf8Bytes("upheld_reason"));
      await expect(ai.connect(compOfficer).resolveAppeal(appealId, 2, 0, reviewReason)) // UPHELD
        .to.emit(ai, "AppealResolved");
      const appeal = await ai.getAppeal(appealId);
      expect(appeal.status).to.equal(2); // UPHELD
    });

    it("should resolve appeal as overturned and update decision", async function () {
      const { ai, compOfficer, appealId, decisionId } = await appealFiledFixture();
      await ai.connect(compOfficer).startAppealReview(appealId);
      const reviewReason = ethers.keccak256(ethers.toUtf8Bytes("overturn_reason"));
      await ai.connect(compOfficer).resolveAppeal(appealId, 3, 1, reviewReason); // OVERTURNED -> FLAGGED
      const decision = await ai.getDecision(decisionId);
      expect(decision.outcome).to.equal(1); // FLAGGED
      expect(decision.overridden).to.be.true;
    });

    it("should revert resolve on non-reviewed appeal", async function () {
      const { ai, compOfficer, appealId } = await appealFiledFixture();
      const reviewReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await expect(ai.connect(compOfficer).resolveAppeal(appealId, 2, 0, reviewReason))
        .to.be.revertedWithCustomError(ai, "AppealNotUnderReview");
    });
  });

  describe("Human Override", function () {
    it("should override a decision", async function () {
      const { ai, compOfficer, decisionId } = await decisionRecordedFixture();
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("override_reason"));
      await expect(ai.connect(compOfficer).overrideDecision(decisionId, 2, overrideReason)) // REJECTED
        .to.emit(ai, "DecisionOverridden");
    });

    it("should update decision outcome after override", async function () {
      const { ai, compOfficer, decisionId } = await decisionRecordedFixture();
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("override_reason"));
      await ai.connect(compOfficer).overrideDecision(decisionId, 1, overrideReason); // -> FLAGGED
      const decision = await ai.getDecision(decisionId);
      expect(decision.outcome).to.equal(1); // FLAGGED
      expect(decision.overridden).to.be.true;
    });

    it("should revert duplicate override", async function () {
      const { ai, compOfficer, decisionId } = await decisionRecordedFixture();
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await ai.connect(compOfficer).overrideDecision(decisionId, 1, overrideReason);
      await expect(ai.connect(compOfficer).overrideDecision(decisionId, 2, overrideReason))
        .to.be.revertedWithCustomError(ai, "DecisionAlreadyOverridden");
    });

    it("should revert override with same outcome", async function () {
      const { ai, compOfficer, decisionId } = await decisionRecordedFixture();
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await expect(ai.connect(compOfficer).overrideDecision(decisionId, 0, overrideReason)) // same APPROVED
        .to.be.revertedWithCustomError(ai, "SameOutcome");
    });

    it("should revert override for non-existent decision", async function () {
      const { ai, compOfficer } = await loadFixture(deployFixture);
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await expect(ai.connect(compOfficer).overrideDecision(ethers.ZeroHash, 1, overrideReason))
        .to.be.revertedWithCustomError(ai, "DecisionNotFound");
    });

    it("should revert override by non-officer", async function () {
      const { ai, other, decisionId } = await decisionRecordedFixture();
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await expect(ai.connect(other).overrideDecision(decisionId, 1, overrideReason))
        .to.be.reverted;
    });

    it("should update outcome counts on override", async function () {
      const { ai, compOfficer, decisionId } = await decisionRecordedFixture();
      const beforeApproved = await ai.getOutcomeCount(0);
      const beforeFlagged = await ai.getOutcomeCount(1);
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await ai.connect(compOfficer).overrideDecision(decisionId, 1, overrideReason);
      expect(await ai.getOutcomeCount(0)).to.equal(beforeApproved - 1n);
      expect(await ai.getOutcomeCount(1)).to.equal(beforeFlagged + 1n);
    });
  });

  describe("Configuration", function () {
    it("should update escalation threshold", async function () {
      const { ai, compOfficer } = await loadFixture(deployFixture);
      await expect(ai.connect(compOfficer).setEscalationThreshold(70))
        .to.emit(ai, "EscalationThresholdUpdated");
      expect(await ai.escalationThreshold()).to.equal(70);
    });

    it("should revert invalid threshold", async function () {
      const { ai, compOfficer } = await loadFixture(deployFixture);
      await expect(ai.connect(compOfficer).setEscalationThreshold(101))
        .to.be.revertedWithCustomError(ai, "InvalidThreshold");
    });
  });

  describe("View Functions", function () {
    it("should return subject decision count", async function () {
      const { ai } = await decisionRecordedFixture();
      expect(await ai.getSubjectDecisionCount(subjectHash)).to.equal(1);
    });

    it("should return decision appeal count", async function () {
      const { ai, decisionId } = await appealFiledFixture();
      expect(await ai.getDecisionAppealCount(decisionId)).to.equal(1);
    });

    it("should return registered model count", async function () {
      const { ai } = await loadFixture(deployFixture);
      expect(await ai.getRegisteredModelCount()).to.equal(1);
    });

    it("should return escalation queue length", async function () {
      const { ai, aiOp, modelId } = await loadFixture(deployFixture);
      await ai.connect(aiOp).recordDecision(subjectHash, modelId, 0, 50, evidenceHash, reasonHash); // low confidence
      expect(await ai.getEscalationQueueLength()).to.equal(1);
    });

    it("should return audit trail", async function () {
      const { ai, compOfficer, decisionId } = await decisionRecordedFixture();
      const overrideReason = ethers.keccak256(ethers.toUtf8Bytes("reason"));
      await ai.connect(compOfficer).overrideDecision(decisionId, 1, overrideReason);
      const [appealIds, overrideIds] = await ai.getAuditTrail(decisionId);
      expect(overrideIds.length).to.equal(1);
    });
  });

  describe("Admin", function () {
    it("should pause and unpause", async function () {
      const { ai, compOfficer } = await loadFixture(deployFixture);
      await ai.connect(compOfficer).pause();
      expect(await ai.paused()).to.be.true;
      await ai.connect(compOfficer).unpause();
      expect(await ai.paused()).to.be.false;
    });
  });
});
