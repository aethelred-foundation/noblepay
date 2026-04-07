import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("Security Audit Fixes", function () {

  // ══════════════════════════════════════════════════════════════
  // NP-01: Delegate double-counting in MultiSigTreasury
  // ══════════════════════════════════════════════════════════════
  describe("NP-01: Delegate double-counting prevention", function () {
    async function deployTreasuryFixture() {
      const [admin, signer1, signer2, signer3, signer4, signer5, delegate1, recipient, other] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const treasury = await Treasury.deploy(
        admin.address,
        [signer1.address, signer2.address, signer3.address, signer4.address, signer5.address],
        2, 3, 4, 4
      );

      await treasury.connect(admin).setSupportedToken(usdc.target, true);
      await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

      // signer1 delegates to delegate1
      await treasury.connect(signer1).delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

      return { treasury, usdc, admin, signer1, signer2, signer3, signer4, signer5, delegate1, recipient, other };
    }

    it("should prevent signer from double-approving via delegate (delegate creates, signer approves)", async function () {
      const { treasury, usdc, signer1, delegate1, recipient } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // Delegate creates proposal (auto-approves as signer1's identity)
      const tx = await treasury.connect(delegate1).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // signer1 tries to approve the same proposal - should revert because
      // the delegate's approval was recorded under signer1's identity
      await expect(treasury.connect(signer1).approveProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "AlreadyApproved");
    });

    it("should prevent signer from double-approving via delegate (signer creates, delegate approves)", async function () {
      const { treasury, usdc, signer1, delegate1, recipient } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // Signer creates proposal (auto-approves)
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // delegate1 (acting for signer1) tries to approve - should revert
      await expect(treasury.connect(delegate1).approveProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "AlreadyApproved");
    });

    it("should still allow different signers to approve", async function () {
      const { treasury, usdc, signer1, signer2, recipient } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // signer2 should be able to approve
      await expect(treasury.connect(signer2).approveProposal(proposalId))
        .to.emit(treasury, "ProposalApproved");

      const prop = await treasury.proposals(proposalId);
      expect(prop.approvalCount).to.equal(2);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-01b: Delegate double-counting in rejectProposal
  // ══════════════════════════════════════════════════════════════
  describe("NP-01b: Delegate double-rejection prevention", function () {
    async function deployTreasuryFixture() {
      const [admin, signer1, signer2, signer3, signer4, signer5, delegate1, recipient, other] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const treasury = await Treasury.deploy(
        admin.address,
        [signer1.address, signer2.address, signer3.address, signer4.address, signer5.address],
        2, 3, 4, 4
      );

      await treasury.connect(admin).setSupportedToken(usdc.target, true);
      await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

      // signer1 delegates to delegate1
      await treasury.connect(signer1).delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

      return { treasury, usdc, admin, signer1, signer2, signer3, signer4, signer5, delegate1, recipient, other };
    }

    it("should prevent signer from double-rejecting via delegate (signer rejects, delegate tries to reject)", async function () {
      const { treasury, usdc, signer1, signer2, delegate1, recipient } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // signer2 creates proposal so signer1 can reject it
      const tx = await treasury.connect(signer2).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // signer1 rejects
      await treasury.connect(signer1).rejectProposal(proposalId);

      // delegate1 (acting for signer1) tries to reject — should revert
      await expect(treasury.connect(delegate1).rejectProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "AlreadyRejected");
    });

    it("should prevent delegate from double-rejecting via signer (delegate rejects, signer tries to reject)", async function () {
      const { treasury, usdc, signer1, signer2, delegate1, recipient } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // signer2 creates proposal
      const tx = await treasury.connect(signer2).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // delegate1 rejects (recorded under signer1's canonical identity)
      await treasury.connect(delegate1).rejectProposal(proposalId);

      // signer1 tries to reject — should revert because already rejected via delegate
      await expect(treasury.connect(signer1).rejectProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "AlreadyRejected");
    });

    it("should still allow different signers to reject independently", async function () {
      const { treasury, usdc, signer1, signer2, signer3, recipient } = await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // signer1 creates proposal
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // signer2 rejects
      await expect(treasury.connect(signer2).rejectProposal(proposalId))
        .to.emit(treasury, "ProposalRejected");

      // signer3 rejects — should also work
      await expect(treasury.connect(signer3).rejectProposal(proposalId))
        .to.emit(treasury, "ProposalRejected");

      const prop = await treasury.proposals(proposalId);
      expect(prop.rejectionCount).to.equal(2);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-05: ComplianceOracle threshold approvals bound to proposed values
  // ══════════════════════════════════════════════════════════════
  describe("NP-05: Threshold approvals bound to proposed values", function () {
    async function deployOracleFixture() {
      const [admin, thresholdMgr, thresholdMgr2, other] = await ethers.getSigners();

      const Oracle = await ethers.getContractFactory("ComplianceOracle");
      const oracle = await Oracle.deploy(admin.address);

      const THRESHOLD_MANAGER_ROLE = await oracle.THRESHOLD_MANAGER_ROLE();
      await oracle.connect(admin).grantRole(THRESHOLD_MANAGER_ROLE, thresholdMgr.address);
      await oracle.connect(admin).grantRole(THRESHOLD_MANAGER_ROLE, thresholdMgr2.address);

      return { oracle, admin, thresholdMgr, thresholdMgr2, other };
    }

    it("should revert when approving with different values than proposed", async function () {
      const { oracle, thresholdMgr, thresholdMgr2 } = await loadFixture(deployOracleFixture);

      // Propose thresholds: lowMax=25, mediumMax=65
      const tx = await oracle.connect(thresholdMgr).proposeThresholdUpdate(25, 65);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
      const proposalId = event.args[0];

      // Try to approve with different values (40, 80 instead of 25, 65)
      await expect(oracle.connect(thresholdMgr2).approveThresholdUpdate(proposalId, 40, 80))
        .to.be.revertedWithCustomError(oracle, "ThresholdValuesMismatch");
    });

    it("should succeed when approving with matching values", async function () {
      const { oracle, thresholdMgr, thresholdMgr2 } = await loadFixture(deployOracleFixture);

      const tx = await oracle.connect(thresholdMgr).proposeThresholdUpdate(25, 65);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
      const proposalId = event.args[0];

      // Approve with matching values
      await expect(oracle.connect(thresholdMgr2).approveThresholdUpdate(proposalId, 25, 65))
        .to.emit(oracle, "RiskThresholdUpdated")
        .withArgs(25, 65, thresholdMgr2.address);

      const [lowMax, mediumMax] = await oracle.getRiskThresholds();
      expect(lowMax).to.equal(25);
      expect(mediumMax).to.equal(65);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-06: CrossChainRouter recovery refunds principal + fee
  // ══════════════════════════════════════════════════════════════
  describe("NP-06: Recovery refunds principal + fee for INITIATED transfers", function () {
    const CHAIN_ID = 137;
    const BASE_FEE = ethers.parseUnits("10", 6);
    const FEE_RATE_BP = 50;
    const FINALITY_BLOCKS = 128;
    const RECOVERY_TIMEOUT = 4 * 3600;
    const MIN_TRANSFER = ethers.parseUnits("100", 6);
    const MAX_TRANSFER = ethers.parseUnits("1000000", 6);

    async function deployRouterFixture() {
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

    it("should refund principal + fee (minus protocol portion) for never-relayed transfer", async function () {
      const { router, usdc, sender } = await loadFixture(deployRouterFixture);
      const amount = ethers.parseUnits("1000", 6);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));

      const senderBalBefore = await usdc.balanceOf(sender.address);

      const tx = await router.connect(sender).initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
      const transferId = event.args[0];
      const fee = event.args[5]; // fee from event

      const senderBalAfterInit = await usdc.balanceOf(sender.address);

      // Wait for recovery timeout
      await time.increase(RECOVERY_TIMEOUT + 1);

      // Recover the transfer
      await router.connect(sender).recoverTransfer(transferId);

      const senderBalAfterRecover = await usdc.balanceOf(sender.address);

      // The refund should be more than just the principal (should include fee minus protocol portion)
      const refunded = senderBalAfterRecover - senderBalAfterInit;

      // Protocol fee = fee * 1000 / 10000 = fee * 10%
      const protocolFee = (fee * 1000n) / 10000n;
      const expectedRefund = amount + fee - protocolFee;

      expect(refunded).to.equal(expectedRefund);
      // Confirm refund is strictly more than just principal
      expect(refunded).to.be.gt(amount);
    });

    it("should refund only principal for FAILED transfers", async function () {
      const { router, usdc, admin, relay1, sender } = await loadFixture(deployRouterFixture);
      const amount = ethers.parseUnits("1000", 6);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));

      const tx = await router.connect(sender).initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
      const transferId = event.args[0];

      const senderBalBeforeRecover = await usdc.balanceOf(sender.address);

      // Mark as failed by admin
      await router.connect(admin).markTransferFailed(transferId, "test failure");

      // Recover
      await router.connect(sender).recoverTransfer(transferId);

      const senderBalAfterRecover = await usdc.balanceOf(sender.address);
      const refunded = senderBalAfterRecover - senderBalBeforeRecover;

      // For FAILED transfers, only principal is refunded
      expect(refunded).to.equal(amount);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-11: Recurring payments require ADMIN_ROLE
  // ══════════════════════════════════════════════════════════════
  describe("NP-11: Recurring payments require ADMIN_ROLE", function () {
    async function deployTreasuryFixture() {
      const [admin, signer1, signer2, signer3, signer4, signer5, recipient, other] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const treasury = await Treasury.deploy(
        admin.address,
        [signer1.address, signer2.address, signer3.address, signer4.address, signer5.address],
        2, 3, 4, 4
      );

      await treasury.connect(admin).setSupportedToken(usdc.target, true);
      await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

      return { treasury, usdc, admin, signer1, signer2, signer3, recipient, other };
    }

    it("should revert when non-admin signer tries to create recurring payment", async function () {
      const { treasury, usdc, signer1, recipient } = await loadFixture(deployTreasuryFixture);
      const ADMIN_ROLE = await treasury.ADMIN_ROLE();

      await expect(
        treasury.connect(signer1).createRecurringPayment(
          recipient.address, usdc.target, ethers.parseUnits("1000", 6),
          0, // DAILY
          0, // OPERATIONS
          "test recurring",
          12,
          ethers.ZeroHash
        )
      ).to.be.revertedWith(
        `AccessControl: account ${signer1.address.toLowerCase()} is missing role ${ADMIN_ROLE}`
      );
    });

    it("should allow admin to create recurring payment", async function () {
      const { treasury, usdc, admin, recipient } = await loadFixture(deployTreasuryFixture);

      await expect(
        treasury.connect(admin).createRecurringPayment(
          recipient.address, usdc.target, ethers.parseUnits("1000", 6),
          0, 0, "test recurring", 12, ethers.ZeroHash
        )
      ).to.emit(treasury, "RecurringPaymentCreated");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-12: batchOpenChannels validates challenge period and fee
  // ══════════════════════════════════════════════════════════════
  describe("NP-12: batchOpenChannels validates channel params", function () {
    async function deployChannelsFixture() {
      const [admin, partyA, partyB, partyC, treasury, other] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const PC = await ethers.getContractFactory("PaymentChannels");
      const pc = await PC.deploy(admin.address, treasury.address, 100);

      await pc.connect(admin).setSupportedToken(usdc.target, true);
      await pc.connect(admin).setKYCStatus(partyA.address, true);
      await pc.connect(admin).setKYCStatus(partyB.address, true);
      await pc.connect(admin).setKYCStatus(partyC.address, true);

      const mintAmount = ethers.parseUnits("10000000", 6);
      await usdc.mint(partyA.address, mintAmount);
      await usdc.connect(partyA).approve(pc.target, ethers.MaxUint256);

      return { pc, usdc, admin, partyA, partyB, partyC, treasury, other };
    }

    it("should revert batchOpenChannels with too-short challenge period", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(deployChannelsFixture);
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc.connect(partyA).batchOpenChannels(
          [partyB.address, partyC.address],
          usdc.target,
          [deposit, deposit],
          60, // 60 seconds - below MIN_CHALLENGE_PERIOD (1 hour)
          100
        )
      ).to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert batchOpenChannels with too-long challenge period", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(deployChannelsFixture);
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc.connect(partyA).batchOpenChannels(
          [partyB.address, partyC.address],
          usdc.target,
          [deposit, deposit],
          8 * 24 * 3600, // 8 days - above MAX_CHALLENGE_PERIOD (7 days)
          100
        )
      ).to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert batchOpenChannels with excessive routing fee", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(deployChannelsFixture);
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc.connect(partyA).batchOpenChannels(
          [partyB.address, partyC.address],
          usdc.target,
          [deposit, deposit],
          24 * 3600, // valid challenge period
          501 // above MAX_ROUTING_FEE_BPS (500)
        )
      ).to.be.revertedWithCustomError(pc, "InvalidFee");
    });

    it("should succeed batchOpenChannels with valid params", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(deployChannelsFixture);
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc.connect(partyA).batchOpenChannels(
          [partyB.address, partyC.address],
          usdc.target,
          [deposit, deposit],
          24 * 3600,
          100
        )
      ).to.emit(pc, "ChannelBatchOpened");
    });
  });
});
