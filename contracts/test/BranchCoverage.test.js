import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

// ================================================================
// MockERC20 burn coverage
// ================================================================
describe("MockERC20 - burn Coverage", function () {
  it("should burn tokens", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Test", "TST", 18);
    const [owner] = await ethers.getSigners();
    await token.mint(owner.address, 1000);
    await token.burn(owner.address, 500);
    expect(await token.balanceOf(owner.address)).to.equal(500);
  });
});

// ================================================================
// StreamingPayments Branch Coverage
// ================================================================
describe("StreamingPayments - Branch Coverage", function () {
  async function deployFixture() {
    const [admin, sender, recipient, other] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const SP = await ethers.getContractFactory("StreamingPayments");
    const sp = await SP.deploy(admin.address);

    await token.mint(sender.address, ethers.parseUnits("10000000", 6));
    await token.connect(sender).approve(sp.target, ethers.MaxUint256);

    return { sp, token, admin, sender, recipient, other };
  }

  async function streamFixture() {
    const fixture = await loadFixture(deployFixture);
    const { sp, token, sender, recipient } = fixture;
    const amount = ethers.parseUnits("100000", 6);
    const duration = 86400 * 30;
    const cliff = 86400 * 7;
    const tx = await sp.connect(sender).createStream(
      recipient.address, token.target, amount, duration, cliff
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];
    return { ...fixture, streamId, amount, duration, cliff };
  }

  it("should create batch streams", async function () {
    const { sp, token, sender, recipient, other } = await loadFixture(deployFixture);
    const amounts = [ethers.parseUnits("10000", 6), ethers.parseUnits("20000", 6)];
    await expect(sp.connect(sender).createBatchStreams(
      [recipient.address, other.address], token.target, amounts, 86400 * 30, 86400 * 7
    )).to.emit(sp, "BatchStreamsCreated");
  });

  it("should revert batch streams with empty array", async function () {
    const { sp, token, sender } = await loadFixture(deployFixture);
    await expect(sp.connect(sender).createBatchStreams(
      [], token.target, [], 86400 * 30, 0
    )).to.be.revertedWithCustomError(sp, "ZeroAmount");
  });

  it("should revert batch streams with array length mismatch", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    await expect(sp.connect(sender).createBatchStreams(
      [recipient.address], token.target, [1000, 2000], 86400 * 30, 0
    )).to.be.revertedWithCustomError(sp, "ArrayLengthMismatch");
  });

  it("should revert batch with zero token", async function () {
    const { sp, sender, recipient } = await loadFixture(deployFixture);
    await expect(sp.connect(sender).createBatchStreams(
      [recipient.address], ethers.ZeroAddress, [1000], 86400 * 30, 0
    )).to.be.revertedWithCustomError(sp, "ZeroAddress");
  });

  it("should revert batch with cliff >= duration", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    await expect(sp.connect(sender).createBatchStreams(
      [recipient.address], token.target, [ethers.parseUnits("10000", 6)], 86400 * 30, 86400 * 30
    )).to.be.revertedWithCustomError(sp, "CliffExceedsDuration");
  });

  it("should pause stream by sender", async function () {
    const { sp, sender, streamId } = await streamFixture();
    await expect(sp.connect(sender).pauseStream(streamId))
      .to.emit(sp, "StreamPaused");
  });

  it("should pause stream by admin", async function () {
    const { sp, admin, streamId } = await streamFixture();
    await expect(sp.connect(admin).pauseStream(streamId))
      .to.emit(sp, "StreamPaused");
  });

  it("should resume a paused stream", async function () {
    const { sp, sender, streamId } = await streamFixture();
    await sp.connect(sender).pauseStream(streamId);
    await expect(sp.connect(sender).resumeStream(streamId))
      .to.emit(sp, "StreamResumed");
  });

  it("should cancel a stream", async function () {
    const { sp, sender, streamId } = await streamFixture();
    await time.increase(86400 * 10);
    await expect(sp.connect(sender).cancelStream(streamId))
      .to.emit(sp, "StreamCancelled");
  });

  it("should cancel a paused stream", async function () {
    const { sp, sender, streamId } = await streamFixture();
    await sp.connect(sender).pauseStream(streamId);
    await time.increase(86400 * 10);
    await expect(sp.connect(sender).cancelStream(streamId))
      .to.emit(sp, "StreamCancelled");
  });

  it("should revert withdraw before cliff", async function () {
    const { sp, recipient, streamId } = await streamFixture();
    await expect(sp.connect(recipient).withdraw(streamId))
      .to.be.revertedWithCustomError(sp, "CliffNotReached");
  });

  it("should withdraw after cliff", async function () {
    const { sp, recipient, streamId } = await streamFixture();
    await time.increase(86400 * 8);
    await expect(sp.connect(recipient).withdraw(streamId))
      .to.emit(sp, "Withdrawal");
  });
});

// ================================================================
// ComplianceOracle Branch Coverage
// ================================================================
describe("ComplianceOracle - Branch Coverage", function () {
  async function deployFixture() {
    const [admin, teeManager, operator, operator2, other] = await ethers.getSigners();
    const CO = await ethers.getContractFactory("ComplianceOracle");
    const co = await CO.deploy(admin.address);

    const TEE_MANAGER_ROLE = await co.TEE_MANAGER_ROLE();
    await co.connect(admin).grantRole(TEE_MANAGER_ROLE, teeManager.address);

    return { co, admin, teeManager, operator, operator2, other };
  }

  async function nodeRegisteredFixture() {
    const fixture = await loadFixture(deployFixture);
    const { co, operator } = fixture;
    const minStake = await co.MIN_STAKE();
    const platformId = ethers.keccak256(ethers.toUtf8Bytes("platform1"));
    await co.connect(operator).registerTEENode(
      "0x04abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678",
      platformId,
      { value: minStake }
    );
    return fixture;
  }

  it("should deregister TEE node by self", async function () {
    const { co, operator } = await nodeRegisteredFixture();
    await expect(co.connect(operator).deregisterTEENode(operator.address))
      .to.emit(co, "TEENodeDeregistered");
  });

  it("should deregister TEE node by manager", async function () {
    const { co, teeManager, operator } = await nodeRegisteredFixture();
    await expect(co.connect(teeManager).deregisterTEENode(operator.address))
      .to.emit(co, "TEENodeDeregistered");
  });

  it("should revert deregister by unauthorized", async function () {
    const { co, other, operator } = await nodeRegisteredFixture();
    await expect(co.connect(other).deregisterTEENode(operator.address))
      .to.be.revertedWith("ComplianceOracle: unauthorized");
  });

  it("should slash an offline node", async function () {
    const { co, teeManager, operator } = await nodeRegisteredFixture();
    const heartbeatInterval = await co.HEARTBEAT_INTERVAL();
    await time.increase(Number(heartbeatInterval) + 1);
    await expect(co.connect(teeManager).slashOfflineNode(operator.address))
      .to.emit(co, "TEENodeSlashed");
  });

  it("should revert slash if node not offline", async function () {
    const { co, teeManager, operator } = await nodeRegisteredFixture();
    await co.connect(operator).heartbeat();
    await expect(co.connect(teeManager).slashOfflineNode(operator.address))
      .to.be.revertedWith("ComplianceOracle: node not offline");
  });

  it("should verify attestation", async function () {
    const { co, teeManager, operator } = await nodeRegisteredFixture();
    const attestData = "0x04abcdef1234567890";
    const expectedHash = ethers.keccak256(attestData);
    await co.connect(teeManager).verifyAttestation(
      operator.address, attestData, expectedHash
    );
  });
});

// ================================================================
// CrossChainRouter Branch Coverage
// ================================================================
describe("CrossChainRouter - Branch Coverage", function () {
  const CHAIN_ID = 137;
  const BASE_FEE = ethers.parseUnits("10", 6);
  const FEE_RATE_BP = 50;
  const FINALITY_BLOCKS = 128;
  const RECOVERY_TIMEOUT = 4 * 3600;
  const MIN_TRANSFER = ethers.parseUnits("100", 6);
  const MAX_TRANSFER = ethers.parseUnits("1000000", 6);

  async function deployFixture() {
    const [admin, relay1, sender, treasuryAddr, other] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Router = await ethers.getContractFactory("CrossChainRouter");
    const router = await Router.deploy(admin.address, treasuryAddr.address);

    await router.connect(admin).setTokenSupport(usdc.target, true);
    await router.connect(admin).addChain(
      CHAIN_ID, "Polygon", BASE_FEE, FEE_RATE_BP, FINALITY_BLOCKS,
      RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER
    );

    const mintAmount = ethers.parseUnits("10000000", 6);
    await usdc.mint(sender.address, mintAmount);
    await usdc.connect(sender).approve(router.target, ethers.MaxUint256);

    return { router, usdc, admin, relay1, sender, treasuryAddr, other };
  }

  async function relayRegisteredFixture() {
    const fixture = await loadFixture(deployFixture);
    const { router, relay1 } = fixture;
    await router.connect(relay1).registerRelay({ value: ethers.parseEther("5") });
    return fixture;
  }

  async function transferFixture() {
    const fixture = await relayRegisteredFixture();
    const { router, usdc, sender } = fixture;
    const amount = ethers.parseUnits("1000", 6);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    const tx = await router.connect(sender).initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
    const transferId = event.args[0];
    return { ...fixture, transferId, amount };
  }

  it("should revert transfer below minimum amount", async function () {
    const { router, usdc, sender } = await relayRegisteredFixture();
    await expect(router.connect(sender).initiateTransfer(
      usdc.target, 1, CHAIN_ID, ethers.keccak256("0x01")
    )).to.be.revertedWithCustomError(router, "AmountBelowMinimum");
  });

  it("should revert transfer above maximum amount", async function () {
    const { router, usdc, sender } = await relayRegisteredFixture();
    const tooMuch = ethers.parseUnits("2000000", 6);
    await usdc.mint(sender.address, tooMuch * 2n);
    await expect(router.connect(sender).initiateTransfer(
      usdc.target, tooMuch, CHAIN_ID, ethers.keccak256("0x01")
    )).to.be.revertedWithCustomError(router, "AmountAboveMaximum");
  });

  it("should revert transfer to unsupported chain", async function () {
    const { router, usdc, sender } = await relayRegisteredFixture();
    await expect(router.connect(sender).initiateTransfer(
      usdc.target, ethers.parseUnits("100", 6), 999999, ethers.keccak256("0x01")
    )).to.be.revertedWithCustomError(router, "UnsupportedChain");
  });

  it("should recover a timed-out transfer by sender", async function () {
    const { router, sender, transferId } = await transferFixture();
    await time.increase(RECOVERY_TIMEOUT + 1);
    await expect(router.connect(sender).recoverTransfer(transferId))
      .to.emit(router, "TransferRecovered");
  });

  it("should recover a timed-out transfer by admin", async function () {
    const { router, admin, transferId } = await transferFixture();
    await time.increase(RECOVERY_TIMEOUT + 1);
    await expect(router.connect(admin).recoverTransfer(transferId))
      .to.emit(router, "TransferRecovered");
  });

  it("should revert recovery by unauthorized", async function () {
    const { router, other, transferId } = await transferFixture();
    await expect(router.connect(other).recoverTransfer(transferId))
      .to.be.revertedWithCustomError(router, "Unauthorized");
  });

  it("should mark transfer as failed", async function () {
    const { router, admin, transferId } = await transferFixture();
    await expect(router.connect(admin).markTransferFailed(transferId, "network error"))
      .to.emit(router, "TransferFailed");
  });

  it("should deregister relay by self", async function () {
    const { router, relay1 } = await relayRegisteredFixture();
    await expect(router.connect(relay1).deregisterRelay(relay1.address))
      .to.emit(router, "RelayDeregistered");
  });

  it("should remove chain", async function () {
    const { router, admin } = await loadFixture(deployFixture);
    await expect(router.connect(admin).removeChain(CHAIN_ID))
      .to.emit(router, "ChainRemoved");
  });
});

// ================================================================
// TravelRule Branch Coverage
// ================================================================
describe("TravelRule - Branch Coverage", function () {
  async function deployFixture() {
    const [admin, teeNode, vasp1, vasp2, other] = await ethers.getSigners();
    const TR = await ethers.getContractFactory("TravelRule");
    const tr = await TR.deploy(admin.address);

    const TEE_NODE_ROLE = await tr.TEE_NODE_ROLE();
    await tr.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);

    await tr.connect(vasp1).registerVASP(
      ethers.keccak256(ethers.toUtf8Bytes("VASP1")),
      "0x04abcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678"
    );
    await tr.connect(vasp2).registerVASP(
      ethers.keccak256(ethers.toUtf8Bytes("VASP2")),
      "0x04fedcba9876543210fedcba9876543210fedcba9876543210fedcba98765432"
    );

    return { tr, admin, teeNode, vasp1, vasp2, other };
  }

  async function travelRuleSubmittedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { tr, teeNode, vasp1, vasp2 } = fixture;
    const paymentId = ethers.keccak256(ethers.toUtf8Bytes("payment1"));
    const tx = await tr.connect(teeNode).submitTravelRuleData(
      paymentId,
      ethers.keccak256(ethers.toUtf8Bytes("originator")),
      vasp1.address,
      ethers.keccak256(ethers.toUtf8Bytes("VASP1")),
      ethers.keccak256(ethers.toUtf8Bytes("beneficiary")),
      vasp2.address,
      ethers.keccak256(ethers.toUtf8Bytes("VASP2")),
      ethers.parseUnits("10000", 6),
      "0x555344",
      ethers.keccak256(ethers.toUtf8Bytes("encrypted"))
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TravelRuleDataSubmitted");
    const travelRuleId = event.args[0];
    return { ...fixture, travelRuleId, paymentId };
  }

  it("should deactivate a VASP", async function () {
    const { tr, admin, vasp1 } = await loadFixture(deployFixture);
    await expect(tr.connect(admin).deactivateVASP(vasp1.address))
      .to.emit(tr, "VASPDeactivated");
  });

  it("should verify travel rule compliance", async function () {
    const { tr, teeNode, travelRuleId } = await travelRuleSubmittedFixture();
    await expect(tr.connect(teeNode).verifyTravelRuleCompliance(travelRuleId))
      .to.emit(tr, "TravelRuleVerified");
  });

  it("should reject travel rule data", async function () {
    const { tr, teeNode, travelRuleId } = await travelRuleSubmittedFixture();
    await expect(tr.connect(teeNode).rejectTravelRuleData(travelRuleId, "Invalid data"))
      .to.emit(tr, "TravelRuleRejected");
  });

  it("should share with receiving institution", async function () {
    const { tr, teeNode, vasp1, vasp2, travelRuleId } = await travelRuleSubmittedFixture();
    // Must verify first before sharing
    await tr.connect(teeNode).verifyTravelRuleCompliance(travelRuleId);
    const sharedDataHash = ethers.keccak256(ethers.toUtf8Bytes("shared"));
    await expect(tr.connect(vasp1).shareWithReceivingInstitution(
      travelRuleId, vasp2.address, sharedDataHash
    )).to.emit(tr, "TravelRuleShared");
  });

  it("should acknowledge travel rule data", async function () {
    const { tr, teeNode, vasp1, vasp2, travelRuleId } = await travelRuleSubmittedFixture();
    // Must verify first before sharing
    await tr.connect(teeNode).verifyTravelRuleCompliance(travelRuleId);
    const sharedDataHash = ethers.keccak256(ethers.toUtf8Bytes("shared"));
    const shareTx = await tr.connect(vasp1).shareWithReceivingInstitution(
      travelRuleId, vasp2.address, sharedDataHash
    );
    const shareReceipt = await shareTx.wait();
    const shareEvent = shareReceipt.logs.find(l => l.fragment && l.fragment.name === "TravelRuleShared");
    const sharingId = shareEvent.args[1];

    await expect(tr.connect(vasp2).acknowledgeTravelRuleData(sharingId))
      .to.emit(tr, "TravelRuleAcknowledged");
  });

  it("should check requiresFullTravelRuleData", async function () {
    const { tr } = await loadFixture(deployFixture);
    const needsFull = await tr.requiresFullTravelRuleData(ethers.parseUnits("2000", 6));
    expect(needsFull).to.be.true;
    const doesntNeed = await tr.requiresFullTravelRuleData(100);
    expect(doesntNeed).to.be.false;
  });

  it("should check isRecordExpired", async function () {
    const { tr, travelRuleId } = await travelRuleSubmittedFixture();
    const expired = await tr.isRecordExpired(travelRuleId);
    expect(expired).to.be.false;
  });
});

// ================================================================
// AIComplianceModule Branch Coverage
// ================================================================
describe("AIComplianceModule - Branch Coverage", function () {
  const subjectHash = ethers.keccak256(ethers.toUtf8Bytes("subject1"));
  const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("reason"));

  async function deployFixture() {
    const [admin, aiOp, officer, appellant, other] = await ethers.getSigners();
    const AIC = await ethers.getContractFactory("AIComplianceModule");
    const aic = await AIC.deploy(admin.address);

    await aic.connect(admin).grantRole(await aic.AI_OPERATOR_ROLE(), aiOp.address);
    await aic.connect(admin).grantRole(await aic.COMPLIANCE_OFFICER_ROLE(), officer.address);

    const modelHash = ethers.keccak256(ethers.toUtf8Bytes("model_v1"));
    const tx = await aic.connect(aiOp).registerModel("AML-Detector", "1.0", modelHash);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ModelRegistered");
    const modelId = event.args[0];

    return { aic, admin, aiOp, officer, appellant, other, modelId };
  }

  async function decisionFixture() {
    const fixture = await loadFixture(deployFixture);
    const { aic, aiOp, modelId } = fixture;
    // FLAGGED=1, high confidence
    const tx = await aic.connect(aiOp).recordDecision(
      subjectHash, modelId, 1, 85, evidenceHash, reasonHash
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
    const decisionId = event.args[0];
    return { ...fixture, decisionId };
  }

  async function appealFiledFixture() {
    const fixture = await decisionFixture();
    const { aic, appellant, decisionId } = fixture;
    const groundsHash = ethers.keccak256(ethers.toUtf8Bytes("grounds"));
    const tx = await aic.connect(appellant).fileAppeal(decisionId, groundsHash);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "AppealFiled");
    const appealId = event.args[0];
    return { ...fixture, appealId };
  }

  it("should auto-escalate low confidence decision", async function () {
    const { aic, aiOp, modelId } = await loadFixture(deployFixture);
    await expect(aic.connect(aiOp).recordDecision(
      ethers.keccak256("0x01"), modelId, 0, 30, evidenceHash, reasonHash
    )).to.emit(aic, "DecisionEscalated");
  });

  it("should file an appeal", async function () {
    const { aic, appellant, decisionId } = await decisionFixture();
    await expect(aic.connect(appellant).fileAppeal(
      decisionId, ethers.keccak256(ethers.toUtf8Bytes("grounds"))
    )).to.emit(aic, "AppealFiled");
  });

  it("should revert appeal after window expired", async function () {
    const { aic, appellant, decisionId } = await decisionFixture();
    await time.increase(30 * 86400 + 1);
    await expect(aic.connect(appellant).fileAppeal(
      decisionId, ethers.keccak256(ethers.toUtf8Bytes("grounds"))
    )).to.be.revertedWithCustomError(aic, "AppealWindowExpired");
  });

  it("should start appeal review", async function () {
    const { aic, officer, appealId } = await appealFiledFixture();
    await expect(aic.connect(officer).startAppealReview(appealId))
      .to.emit(aic, "AppealReviewStarted");
  });

  it("should resolve appeal with UPHELD", async function () {
    const { aic, officer, appealId } = await appealFiledFixture();
    await aic.connect(officer).startAppealReview(appealId);
    // resolveAppeal(appealId, AppealStatus, DecisionOutcome, reviewReasonHash)
    // UPHELD = 3
    await expect(aic.connect(officer).resolveAppeal(appealId, 3, 1, ethers.keccak256("0x03")))
      .to.emit(aic, "AppealResolved");
  });

  it("should resolve appeal with OVERTURNED", async function () {
    const { aic, officer, appealId } = await appealFiledFixture();
    await aic.connect(officer).startAppealReview(appealId);
    // OVERTURNED = 4
    await expect(aic.connect(officer).resolveAppeal(appealId, 4, 0, ethers.keccak256("0x03")))
      .to.emit(aic, "AppealResolved");
  });

  it("should override a decision", async function () {
    const { aic, officer, decisionId } = await decisionFixture();
    // Override from FLAGGED (1) to APPROVED (0)
    await expect(aic.connect(officer).overrideDecision(
      decisionId, 0, ethers.keccak256(ethers.toUtf8Bytes("reason"))
    )).to.emit(aic, "DecisionOverridden");
  });

  it("should revert override with same outcome", async function () {
    const { aic, officer, decisionId } = await decisionFixture();
    await expect(aic.connect(officer).overrideDecision(
      decisionId, 1, ethers.keccak256(ethers.toUtf8Bytes("reason"))
    )).to.be.revertedWithCustomError(aic, "SameOutcome");
  });

  it("should update escalation threshold", async function () {
    const { aic, officer } = await loadFixture(deployFixture);
    await aic.connect(officer).setEscalationThreshold(70);
    expect(await aic.escalationThreshold()).to.equal(70);
  });

  it("should update model status", async function () {
    const { aic, aiOp, modelId } = await loadFixture(deployFixture);
    await expect(aic.connect(aiOp).updateModelStatus(modelId, 1))
      .to.emit(aic, "ModelStatusUpdated");
  });
});

// ================================================================
// BusinessRegistry Branch Coverage
// ================================================================
describe("BusinessRegistry - Branch Coverage", function () {
  async function deployFixture() {
    const [admin, verifier, biz1, biz2, officer1, officer2, other] = await ethers.getSigners();
    const BR = await ethers.getContractFactory("BusinessRegistry");
    const br = await BR.deploy(admin.address);

    const VERIFIER_ROLE = await br.VERIFIER_ROLE();
    await br.connect(admin).grantRole(VERIFIER_ROLE, verifier.address);

    return { br, admin, verifier, biz1, biz2, officer1, officer2, other };
  }

  async function registeredFixture() {
    const fixture = await loadFixture(deployFixture);
    const { br, biz1, officer1 } = fixture;
    await br.connect(biz1).registerBusiness("ABC123", "Test Corp", 0, officer1.address);
    return fixture;
  }

  async function verifiedFixture() {
    const fixture = await registeredFixture();
    const { br, verifier, biz1 } = fixture;
    await br.connect(verifier).verifyBusiness(biz1.address);
    return fixture;
  }

  it("should suspend a verified business", async function () {
    const { br, verifier, biz1 } = await verifiedFixture();
    await expect(br.connect(verifier).suspendBusiness(biz1.address, "AML violation"))
      .to.emit(br, "BusinessSuspended");
  });

  it("should revert suspending non-verified business", async function () {
    const { br, verifier, biz1 } = await registeredFixture();
    await expect(br.connect(verifier).suspendBusiness(biz1.address, "test"))
      .to.be.revertedWithCustomError(br, "InvalidKYCStatus");
  });

  it("should reinstate a suspended business", async function () {
    const { br, verifier, biz1 } = await verifiedFixture();
    await br.connect(verifier).suspendBusiness(biz1.address, "temp");
    await expect(br.connect(verifier).reinstateBusiness(biz1.address))
      .to.emit(br, "BusinessReinstated");
  });

  it("should revert reinstate of non-suspended business", async function () {
    const { br, verifier, biz1 } = await verifiedFixture();
    await expect(br.connect(verifier).reinstateBusiness(biz1.address))
      .to.be.revertedWithCustomError(br, "InvalidKYCStatus");
  });

  it("should revoke a business", async function () {
    const { br, admin, biz1 } = await registeredFixture();
    await expect(br.connect(admin).revokeBusiness(biz1.address, "fraud"))
      .to.emit(br, "BusinessRevoked");
  });

  it("should upgrade business tier", async function () {
    const { br, admin, biz1 } = await verifiedFixture();
    await expect(br.connect(admin).upgradeTier(biz1.address, 1))
      .to.emit(br, "TierUpgraded");
  });

  it("should revert tier downgrade", async function () {
    const { br, admin, biz1 } = await verifiedFixture();
    await br.connect(admin).upgradeTier(biz1.address, 1);
    await expect(br.connect(admin).upgradeTier(biz1.address, 0))
      .to.be.revertedWithCustomError(br, "CannotDowngradeTier");
  });

  it("should update compliance officer", async function () {
    const { br, biz1, officer2 } = await registeredFixture();
    await expect(br.connect(biz1).updateComplianceOfficer(officer2.address))
      .to.emit(br, "ComplianceOfficerUpdated");
  });

  it("should check needsReverification for recently verified", async function () {
    const { br, biz1 } = await verifiedFixture();
    const needs = await br.needsReverification(biz1.address);
    expect(needs).to.be.false;
  });

  it("should check needsReverification after expiry", async function () {
    const { br, biz1 } = await verifiedFixture();
    await time.increase(366 * 86400);
    const needs = await br.needsReverification(biz1.address);
    expect(needs).to.be.true;
  });

  it("should revert duplicate license registration", async function () {
    const { br, biz2, officer1 } = await registeredFixture();
    await expect(br.connect(biz2).registerBusiness("ABC123", "Other Corp", 1, officer1.address))
      .to.be.revertedWithCustomError(br, "LicenseAlreadyRegistered");
  });
});

// ================================================================
// PaymentChannels Branch Coverage
// ================================================================
describe("PaymentChannels - Branch Coverage", function () {
  async function deployFixture() {
    const [admin, partyA, partyB, router, treasury, other] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const PC = await ethers.getContractFactory("PaymentChannels");
    const pc = await PC.deploy(admin.address, treasury.address, 100);

    await pc.connect(admin).setSupportedToken(usdc.target, true);
    await pc.connect(admin).setKYCStatus(partyA.address, true);
    await pc.connect(admin).setKYCStatus(partyB.address, true);

    const mintAmount = ethers.parseUnits("10000000", 6);
    await usdc.mint(partyA.address, mintAmount);
    await usdc.mint(partyB.address, mintAmount);
    await usdc.connect(partyA).approve(pc.target, ethers.MaxUint256);
    await usdc.connect(partyB).approve(pc.target, ethers.MaxUint256);

    return { pc, usdc, admin, partyA, partyB, router, treasury, other };
  }

  const DEPOSIT = ethers.parseUnits("10000", 6);
  const CHALLENGE_PERIOD = 24 * 3600;

  async function channelFixture() {
    const fixture = await loadFixture(deployFixture);
    const { pc, usdc, partyA, partyB } = fixture;
    const tx = await pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
    const channelId = event.args[0];

    await pc.connect(partyB).fundChannel(channelId, DEPOSIT);
    return { ...fixture, channelId };
  }

  it("should open and join a channel", async function () {
    const { pc, channelId } = await channelFixture();
    const ch = await pc.getChannel(channelId);
    expect(ch.partyA).to.not.equal(ethers.ZeroAddress);
  });

  it("should initiate unilateral close", async function () {
    const { pc, partyA, partyB, channelId } = await channelFixture();
    const nonce = 1;
    const balA = DEPOSIT;
    const balB = DEPOSIT;
    // State hash must include "STATE" suffix per contract
    const stateHash = ethers.keccak256(
      ethers.solidityPacked(
        ["bytes32", "uint256", "uint256", "uint256", "string"],
        [channelId, balA, balB, nonce, "STATE"]
      )
    );
    // Signature must be from counterparty (partyB signs, partyA submits)
    const sig = await partyB.signMessage(ethers.getBytes(stateHash));
    await expect(pc.connect(partyA).initiateUnilateralClose(
      channelId, balA, balB, nonce, sig
    )).to.emit(pc, "ChannelUnilateralClose");
  });

  it("should revert batch open with unsupported token", async function () {
    const { pc, partyA, partyB, other } = await loadFixture(deployFixture);
    await expect(pc.connect(partyA).batchOpenChannels(
      [partyB.address], other.address, [DEPOSIT], CHALLENGE_PERIOD, 50
    )).to.be.revertedWithCustomError(pc, "UnsupportedToken");
  });
});

// ================================================================
// InvoiceFinancing Branch Coverage
// ================================================================
describe("InvoiceFinancing - Branch Coverage", function () {
  async function deployFixture() {
    const [admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const IF = await ethers.getContractFactory("InvoiceFinancing");
    const invoicing = await IF.deploy(admin.address, treasuryAddr.address, 100);

    const FACTOR_ROLE = await invoicing.FACTOR_ROLE();
    const CREDIT_ANALYST_ROLE = await invoicing.CREDIT_ANALYST_ROLE();
    const ARBITER_ROLE = await invoicing.ARBITER_ROLE();
    await invoicing.connect(admin).grantRole(FACTOR_ROLE, factor.address);
    await invoicing.connect(admin).grantRole(CREDIT_ANALYST_ROLE, analyst.address);
    await invoicing.connect(admin).grantRole(ARBITER_ROLE, arbiter.address);

    await invoicing.connect(admin).setSupportedToken(token.target, true);

    const amount = ethers.parseUnits("10000000", 6);
    await token.mint(creditor.address, amount);
    await token.mint(debtor.address, amount);
    await token.mint(factor.address, amount);
    await token.connect(creditor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(debtor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(factor).approve(invoicing.target, ethers.MaxUint256);

    return { invoicing, token, admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr };
  }

  async function invoiceFixture() {
    const fixture = await loadFixture(deployFixture);
    const { invoicing, token, creditor, debtor } = fixture;
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("inv001"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];
    return { ...fixture, invoiceId, faceValue, maturity };
  }

  it("should create a chained invoice", async function () {
    const { invoicing, token, creditor, debtor, other, invoiceId } = await invoiceFixture();
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("child"));
    // createChainedInvoice must be called by the parent's debtor (debtor becomes creditor of the child)
    await expect(invoicing.connect(debtor).createChainedInvoice(
      invoiceId, other.address, ethers.parseUnits("50000", 6), maturity, docHash, 7, 200
    )).to.emit(invoicing, "InvoiceCreated");
  });

  it("should revert invoice with zero face value", async function () {
    const { invoicing, token, creditor, debtor } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    await expect(invoicing.connect(creditor).createInvoice(
      debtor.address, 0, token.target, maturity, ethers.ZeroHash, 7, 200
    )).to.be.revertedWithCustomError(invoicing, "ZeroAmount");
  });

  it("should revert invoice with maturity in past", async function () {
    const { invoicing, token, creditor, debtor } = await loadFixture(deployFixture);
    await expect(invoicing.connect(creditor).createInvoice(
      debtor.address, ethers.parseUnits("1000", 6), token.target, 1, ethers.ZeroHash, 7, 200
    )).to.be.revertedWithCustomError(invoicing, "MaturityInPast");
  });

  it("should revert debtor = zero address", async function () {
    const { invoicing, token, creditor } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    await expect(invoicing.connect(creditor).createInvoice(
      ethers.ZeroAddress, ethers.parseUnits("1000", 6), token.target, maturity, ethers.ZeroHash, 7, 200
    )).to.be.revertedWithCustomError(invoicing, "ZeroAddress");
  });

  it("should initiate dispute by debtor", async function () {
    const { invoicing, debtor, invoiceId } = await invoiceFixture();
    await expect(invoicing.connect(debtor).initiateDispute(invoiceId, "disputed"))
      .to.emit(invoicing, "DisputeInitiated");
  });

  it("should get suggested discount rate", async function () {
    const { invoicing, creditor } = await loadFixture(deployFixture);
    const rate = await invoicing.getSuggestedDiscountRate(creditor.address);
    expect(rate).to.be.greaterThan(0);
  });

  it("should batch create invoices", async function () {
    const { invoicing, token, creditor, debtor, other } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const fv1 = ethers.parseUnits("10000", 6);
    const fv2 = ethers.parseUnits("20000", 6);
    await expect(invoicing.connect(creditor).batchCreateInvoices(
      [debtor.address, other.address],
      [fv1, fv2],
      token.target,
      [maturity, maturity],
      [ethers.keccak256("0x01"), ethers.keccak256("0x02")],
      7, 200
    )).to.emit(invoicing, "InvoiceCreated");
  });

  it("should revert batch with empty array", async function () {
    const { invoicing, token, creditor } = await loadFixture(deployFixture);
    await expect(invoicing.connect(creditor).batchCreateInvoices(
      [], [], token.target, [], [], 7, 200
    )).to.be.revertedWithCustomError(invoicing, "ZeroAmount");
  });
});
