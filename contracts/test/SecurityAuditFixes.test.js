const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { configureMockBusinessRegistry } = require("./helpers/paymentChannels");

describe("Security Audit Fixes", function () {
  // ══════════════════════════════════════════════════════════════
  // NP-01: Delegate double-counting in MultiSigTreasury
  // ══════════════════════════════════════════════════════════════
  describe("NP-01: Delegate double-counting prevention", function () {
    async function deployTreasuryFixture() {
      const [
        admin,
        signer1,
        signer2,
        signer3,
        signer4,
        signer5,
        delegate1,
        recipient,
        other,
      ] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const treasury = await Treasury.deploy(
        admin.address,
        [
          signer1.address,
          signer2.address,
          signer3.address,
          signer4.address,
          signer5.address,
        ],
        2,
        3,
        4,
        4,
      );

      await treasury.connect(admin).setSupportedToken(usdc.target, true);
      await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

      // signer1 delegates to delegate1
      await treasury
        .connect(signer1)
        .delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

      return {
        treasury,
        usdc,
        admin,
        signer1,
        signer2,
        signer3,
        signer4,
        signer5,
        delegate1,
        recipient,
        other,
      };
    }

    it("should prevent signer from double-approving via delegate (delegate creates, signer approves)", async function () {
      const { treasury, usdc, signer1, delegate1, recipient } =
        await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // Delegate creates proposal (auto-approves as signer1's identity)
      const tx = await treasury
        .connect(delegate1)
        .createProposal(
          recipient.address,
          usdc.target,
          amount,
          0,
          "test",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ProposalCreated",
      );
      const proposalId = event.args[0];

      // signer1 tries to approve the same proposal - should revert because
      // the delegate's approval was recorded under signer1's identity
      await expect(
        treasury.connect(signer1).approveProposal(proposalId),
      ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");
    });

    it("should prevent signer from double-approving via delegate (signer creates, delegate approves)", async function () {
      const { treasury, usdc, signer1, delegate1, recipient } =
        await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // Signer creates proposal (auto-approves)
      const tx = await treasury
        .connect(signer1)
        .createProposal(
          recipient.address,
          usdc.target,
          amount,
          0,
          "test",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ProposalCreated",
      );
      const proposalId = event.args[0];

      // delegate1 (acting for signer1) tries to approve - should revert
      await expect(
        treasury.connect(delegate1).approveProposal(proposalId),
      ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");
    });

    it("should still allow different signers to approve", async function () {
      const { treasury, usdc, signer1, signer2, recipient } = await loadFixture(
        deployTreasuryFixture,
      );
      const amount = ethers.parseUnits("5000", 6);

      const tx = await treasury
        .connect(signer1)
        .createProposal(
          recipient.address,
          usdc.target,
          amount,
          0,
          "test",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ProposalCreated",
      );
      const proposalId = event.args[0];

      // signer2 should be able to approve
      await expect(
        treasury.connect(signer2).approveProposal(proposalId),
      ).to.emit(treasury, "ProposalApproved");

      const prop = await treasury.proposals(proposalId);
      expect(prop.approvalCount).to.equal(2);
    });

    it("counts multiple delegates of the same signer as one approval identity", async function () {
      const { treasury, usdc, signer1, delegate1, other, recipient } =
        await loadFixture(deployTreasuryFixture);
      await treasury
        .connect(signer1)
        .delegateSigningAuthority(other.address, 7 * 24 * 3600);

      const tx = await treasury
        .connect(delegate1)
        .createProposal(
          recipient.address,
          usdc.target,
          ethers.parseUnits("5000", 6),
          0,
          "multi-delegate",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const proposalId = receipt.logs.find(
        (log) => log.fragment?.name === "ProposalCreated",
      ).args.proposalId;

      await expect(
        treasury.connect(other).approveProposal(proposalId),
      ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");
      expect((await treasury.proposals(proposalId)).approvalCount).to.equal(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-01b: Delegate double-counting in rejectProposal
  // ══════════════════════════════════════════════════════════════
  describe("NP-01b: Delegate double-rejection prevention", function () {
    async function deployTreasuryFixture() {
      const [
        admin,
        signer1,
        signer2,
        signer3,
        signer4,
        signer5,
        delegate1,
        recipient,
        other,
      ] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const treasury = await Treasury.deploy(
        admin.address,
        [
          signer1.address,
          signer2.address,
          signer3.address,
          signer4.address,
          signer5.address,
        ],
        2,
        3,
        4,
        4,
      );

      await treasury.connect(admin).setSupportedToken(usdc.target, true);
      await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

      // signer1 delegates to delegate1
      await treasury
        .connect(signer1)
        .delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

      return {
        treasury,
        usdc,
        admin,
        signer1,
        signer2,
        signer3,
        signer4,
        signer5,
        delegate1,
        recipient,
        other,
      };
    }

    it("should prevent signer from double-rejecting via delegate (signer rejects, delegate tries to reject)", async function () {
      const { treasury, usdc, signer1, signer2, delegate1, recipient } =
        await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // signer2 creates proposal so signer1 can reject it
      const tx = await treasury
        .connect(signer2)
        .createProposal(
          recipient.address,
          usdc.target,
          amount,
          0,
          "test",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ProposalCreated",
      );
      const proposalId = event.args[0];

      // signer1 rejects
      await treasury.connect(signer1).rejectProposal(proposalId);

      // delegate1 (acting for signer1) tries to reject — should revert
      await expect(
        treasury.connect(delegate1).rejectProposal(proposalId),
      ).to.be.revertedWithCustomError(treasury, "AlreadyRejected");
    });

    it("should prevent delegate from double-rejecting via signer (delegate rejects, signer tries to reject)", async function () {
      const { treasury, usdc, signer1, signer2, delegate1, recipient } =
        await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // signer2 creates proposal
      const tx = await treasury
        .connect(signer2)
        .createProposal(
          recipient.address,
          usdc.target,
          amount,
          0,
          "test",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ProposalCreated",
      );
      const proposalId = event.args[0];

      // delegate1 rejects (recorded under signer1's canonical identity)
      await treasury.connect(delegate1).rejectProposal(proposalId);

      // signer1 tries to reject — should revert because already rejected via delegate
      await expect(
        treasury.connect(signer1).rejectProposal(proposalId),
      ).to.be.revertedWithCustomError(treasury, "AlreadyRejected");
    });

    it("should still allow different signers to reject independently", async function () {
      const { treasury, usdc, signer1, signer2, signer3, recipient } =
        await loadFixture(deployTreasuryFixture);
      const amount = ethers.parseUnits("5000", 6);

      // signer1 creates proposal
      const tx = await treasury
        .connect(signer1)
        .createProposal(
          recipient.address,
          usdc.target,
          amount,
          0,
          "test",
          false,
          ethers.ZeroHash,
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ProposalCreated",
      );
      const proposalId = event.args[0];

      // signer2 rejects
      await expect(
        treasury.connect(signer2).rejectProposal(proposalId),
      ).to.emit(treasury, "ProposalRejected");

      // signer3 rejects — should also work
      await expect(
        treasury.connect(signer3).rejectProposal(proposalId),
      ).to.emit(treasury, "ProposalRejected");

      const prop = await treasury.proposals(proposalId);
      expect(prop.rejectionCount).to.equal(2);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-05: ComplianceOracle threshold approvals bound to proposed values
  // ══════════════════════════════════════════════════════════════
  describe("NP-05: Threshold approvals bound to proposed values", function () {
    async function deployOracleFixture() {
      const [admin, thresholdMgr, thresholdMgr2, other] =
        await ethers.getSigners();

      const Oracle = await ethers.getContractFactory("ComplianceOracle");
      const oracle = await Oracle.deploy(admin.address);

      const THRESHOLD_MANAGER_ROLE = await oracle.THRESHOLD_MANAGER_ROLE();
      await oracle
        .connect(admin)
        .grantRole(THRESHOLD_MANAGER_ROLE, thresholdMgr.address);
      await oracle
        .connect(admin)
        .grantRole(THRESHOLD_MANAGER_ROLE, thresholdMgr2.address);

      return { oracle, admin, thresholdMgr, thresholdMgr2, other };
    }

    it("should revert when approving with different values than proposed", async function () {
      const { oracle, admin, thresholdMgr, thresholdMgr2 } =
        await loadFixture(deployOracleFixture);

      // Propose thresholds: lowMax=25, mediumMax=65
      const tx = await oracle
        .connect(thresholdMgr)
        .proposeThresholdUpdate(25, 65);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ThresholdChangeProposed",
      );
      const proposalId = event.args[0];

      // Try to approve with different values (40, 80 instead of 25, 65)
      await expect(
        oracle
          .connect(thresholdMgr2)
          .approveThresholdUpdate(proposalId, 40, 80),
      ).to.be.revertedWithCustomError(oracle, "ThresholdValuesMismatch");
    });

    it("should succeed when approving with matching values", async function () {
      const { oracle, admin, thresholdMgr, thresholdMgr2 } =
        await loadFixture(deployOracleFixture);

      const tx = await oracle
        .connect(thresholdMgr)
        .proposeThresholdUpdate(25, 65);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "ThresholdChangeProposed",
      );
      const proposalId = event.args[0];

      // Approve with matching values
      await expect(
        oracle
          .connect(thresholdMgr2)
          .approveThresholdUpdate(proposalId, 25, 65),
      )
        .to.emit(oracle, "RiskThresholdUpdated")
        .withArgs(25, 65, thresholdMgr2.address);

      const [lowMax, mediumMax] = await oracle.getRiskThresholds();
      expect(lowMax).to.equal(25);
      expect(mediumMax).to.equal(65);
      expect(await oracle.thresholdChangeApprovals(proposalId)).to.equal(0);
      expect((await oracle.proposedThresholds(proposalId)).exists).to.equal(
        false,
      );

      await expect(
        oracle.connect(admin).approveThresholdUpdate(proposalId, 25, 65),
      ).to.be.revertedWith("ComplianceOracle: proposal not found");
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
      const [admin, relay1, sender, treasuryAddr, other] =
        await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Router = await ethers.getContractFactory("CrossChainRouter");
      const router = await Router.deploy(admin.address, treasuryAddr.address);

      await router.connect(admin).setTokenSupport(usdc.target, true);
      await router
        .connect(admin)
        .addChain(
          CHAIN_ID,
          "Polygon",
          BASE_FEE,
          FEE_RATE_BP,
          FINALITY_BLOCKS,
          RECOVERY_TIMEOUT,
          MIN_TRANSFER,
          MAX_TRANSFER,
        );

      const mintAmount = ethers.parseUnits("10000000", 6);
      await usdc.mint(sender.address, mintAmount);
      await usdc.connect(sender).approve(router.target, ethers.MaxUint256);

      return { router, usdc, admin, relay1, sender, treasuryAddr, other };
    }

    it("escrows fees and refunds principal plus the full fee for never-relayed transfers", async function () {
      const { router, usdc, sender, treasuryAddr } =
        await loadFixture(deployRouterFixture);
      const amount = ethers.parseUnits("1000", 6);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));

      const senderBalBefore = await usdc.balanceOf(sender.address);

      const tx = await router
        .connect(sender)
        .initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "TransferInitiated",
      );
      const transferId = event.args[0];
      const fee = event.args[5]; // fee from event

      const senderBalAfterInit = await usdc.balanceOf(sender.address);
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(0);

      // Wait for recovery timeout
      await time.increase(RECOVERY_TIMEOUT + 1);

      // Recover the transfer
      await router.connect(sender).recoverTransfer(transferId);

      const senderBalAfterRecover = await usdc.balanceOf(sender.address);

      const refunded = senderBalAfterRecover - senderBalAfterInit;
      expect(refunded).to.equal(amount + fee);
      expect(senderBalAfterRecover).to.equal(senderBalBefore);
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(0);
    });

    it("refunds all escrowed principal and fees when an initiated transfer is failed", async function () {
      const { router, usdc, admin, relay1, sender } =
        await loadFixture(deployRouterFixture);
      const amount = ethers.parseUnits("1000", 6);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));

      const tx = await router
        .connect(sender)
        .initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "TransferInitiated",
      );
      const transferId = event.args[0];
      const fee = event.args.fee;

      const senderBalBeforeRecover = await usdc.balanceOf(sender.address);

      // Mark as failed by admin
      await router
        .connect(admin)
        .markTransferFailed(transferId, "test failure");

      // Recover
      await router.connect(sender).recoverTransfer(transferId);

      const senderBalAfterRecover = await usdc.balanceOf(sender.address);
      const refunded = senderBalAfterRecover - senderBalBeforeRecover;

      expect(refunded).to.equal(amount + fee);
    });

    it("releases the snapshotted protocol and relay fee only after confirmation", async function () {
      const { router, usdc, admin, relay1, sender, treasuryAddr } =
        await loadFixture(deployRouterFixture);
      const amount = ethers.parseUnits("1000", 6);
      await router
        .connect(relay1)
        .registerRelay({ value: ethers.parseEther("5") });

      const tx = await router
        .connect(sender)
        .initiateTransfer(
          usdc.target,
          amount,
          CHAIN_ID,
          ethers.keccak256(ethers.toUtf8Bytes("recipient")),
        );
      const receipt = await tx.wait();
      const initiated = receipt.logs.find(
        (log) => log.fragment?.name === "TransferInitiated",
      );
      const transferId = initiated.args.transferId;
      const fee = initiated.args.fee;
      const expectedProtocolFee = (fee * 1000n) / 10_000n;

      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(0);
      expect(await usdc.balanceOf(relay1.address)).to.equal(0);

      await router
        .connect(relay1)
        .submitRelayProof(
          transferId,
          ethers.keccak256(ethers.toUtf8Bytes("destination tx")),
          "0x1234",
        );
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(0);
      expect(await usdc.balanceOf(relay1.address)).to.equal(0);

      await router.connect(admin).confirmTransfer(transferId);
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(
        expectedProtocolFee,
      );
      expect(await usdc.balanceOf(relay1.address)).to.equal(
        fee - expectedProtocolFee,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-11: Recurring mandates require threshold approval and timelock
  // ══════════════════════════════════════════════════════════════
  describe("NP-11: Recurring mandate governance", function () {
    async function deployTreasuryFixture() {
      const [
        admin,
        signer1,
        signer2,
        signer3,
        signer4,
        signer5,
        recipient,
        other,
      ] = await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const treasury = await Treasury.deploy(
        admin.address,
        [
          signer1.address,
          signer2.address,
          signer3.address,
          signer4.address,
          signer5.address,
        ],
        2,
        3,
        4,
        4,
      );

      await treasury.connect(admin).setSupportedToken(usdc.target, true);
      await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

      return {
        treasury,
        usdc,
        admin,
        signer1,
        signer2,
        signer3,
        recipient,
        other,
      };
    }

    const recurringArgs = (recipient, usdc) => [
      recipient.address,
      usdc.target,
      ethers.parseUnits("1000", 6),
      0,
      0,
      "test recurring",
      12,
      ethers.ZeroHash,
    ];

    async function proposedAuthorization(treasury, signer, args) {
      const tx = await treasury
        .connect(signer)
        .proposeRecurringPayment(...args);
      const receipt = await tx.wait();
      return receipt.logs.find(
        (log) => log.fragment?.name === "RecurringAuthorizationProposed",
      ).args.authorizationId;
    }

    it("blocks a single admin from creating an unapproved standing order", async function () {
      const { treasury, usdc, admin, recipient } = await loadFixture(
        deployTreasuryFixture,
      );
      await expect(
        treasury
          .connect(admin)
          .createRecurringPayment(...recurringArgs(recipient, usdc)),
      ).to.be.revertedWithCustomError(
        treasury,
        "RecurringAuthorizationNotFound",
      );
    });

    it("requires the configured signer threshold and normal timelock", async function () {
      const { treasury, usdc, admin, signer1, signer2, recipient } =
        await loadFixture(deployTreasuryFixture);
      const args = recurringArgs(recipient, usdc);
      const authorizationId = await proposedAuthorization(
        treasury,
        signer1,
        args,
      );

      await expect(
        treasury.connect(admin).createRecurringPayment(...args),
      ).to.be.revertedWithCustomError(
        treasury,
        "RecurringAuthorizationUnavailable",
      );

      await treasury.connect(signer2).approveRecurringPayment(authorizationId);
      await expect(
        treasury.connect(admin).createRecurringPayment(...args),
      ).to.be.revertedWithCustomError(treasury, "TimelockNotExpired");

      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(admin).createRecurringPayment(...args))
        .to.emit(treasury, "RecurringPaymentCreated")
        .and.to.emit(treasury, "RecurringAuthorizationConsumed");
    });

    it("binds approval to every term and consumes it exactly once", async function () {
      const { treasury, usdc, admin, signer1, signer2, recipient } =
        await loadFixture(deployTreasuryFixture);
      const args = recurringArgs(recipient, usdc);
      const authorizationId = await proposedAuthorization(
        treasury,
        signer1,
        args,
      );
      await treasury.connect(signer2).approveRecurringPayment(authorizationId);
      await time.increase(24 * 3600 + 1);

      const alteredArgs = [...args];
      alteredArgs[6] = 24;
      await expect(
        treasury.connect(admin).createRecurringPayment(...alteredArgs),
      ).to.be.revertedWithCustomError(
        treasury,
        "RecurringAuthorizationNotFound",
      );

      await treasury.connect(admin).createRecurringPayment(...args);
      await expect(
        treasury.connect(admin).createRecurringPayment(...args),
      ).to.be.revertedWithCustomError(
        treasury,
        "RecurringAuthorizationUnavailable",
      );
    });

    it("uses canonical signer identity and permits reproposal after expiry", async function () {
      const { treasury, usdc, signer1, other, recipient } = await loadFixture(
        deployTreasuryFixture,
      );
      const args = recurringArgs(recipient, usdc);
      await treasury
        .connect(signer1)
        .delegateSigningAuthority(other.address, 30 * 24 * 3600);
      const authorizationId = await proposedAuthorization(
        treasury,
        signer1,
        args,
      );

      await expect(
        treasury.connect(other).approveRecurringPayment(authorizationId),
      ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");

      await time.increase(7 * 24 * 3600 + 1);
      await expect(
        treasury.connect(signer1).proposeRecurringPayment(...args),
      ).to.emit(treasury, "RecurringAuthorizationProposed");
    });
  });

  // ══════════════════════════════════════════════════════════════
  // NP-12: batchOpenChannels validates challenge period and fee
  // ══════════════════════════════════════════════════════════════
  describe("NP-12: batchOpenChannels validates channel params", function () {
    async function deployChannelsFixture() {
      const [admin, partyA, partyB, partyC, treasury, other] =
        await ethers.getSigners();

      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);

      const PC = await ethers.getContractFactory("PaymentChannels");
      const pc = await PC.deploy(admin.address, treasury.address, 100);

      await pc.connect(admin).setSupportedToken(usdc.target, true);
      await configureMockBusinessRegistry(pc, admin, [partyA, partyB, partyC]);

      const mintAmount = ethers.parseUnits("10000000", 6);
      await usdc.mint(partyA.address, mintAmount);
      await usdc.connect(partyA).approve(pc.target, ethers.MaxUint256);

      return { pc, usdc, admin, partyA, partyB, partyC, treasury, other };
    }

    it("should revert batchOpenChannels with too-short challenge period", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(
        deployChannelsFixture,
      );
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, partyC.address],
            usdc.target,
            [deposit, deposit],
            60,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert batchOpenChannels with too-long challenge period", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(
        deployChannelsFixture,
      );
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, partyC.address],
            usdc.target,
            [deposit, deposit],
            8 * 24 * 3600,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should succeed batchOpenChannels with valid params", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(
        deployChannelsFixture,
      );
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, partyC.address],
            usdc.target,
            [deposit, deposit],
            24 * 3600,
          ),
      ).to.emit(pc, "ChannelBatchOpened");
    });

    it("applies the single-channel zero/self counterparty checks to every batch entry", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(
        deployChannelsFixture,
      );
      const deposit = ethers.parseUnits("1000", 6);

      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, partyA.address],
            usdc.target,
            [deposit, deposit],
            24 * 3600,
          ),
      ).to.be.revertedWithCustomError(pc, "ZeroAddress");

      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, ethers.ZeroAddress],
            usdc.target,
            [deposit, deposit],
            24 * 3600,
          ),
      ).to.be.revertedWithCustomError(pc, "ZeroAddress");
    });
  });
});
