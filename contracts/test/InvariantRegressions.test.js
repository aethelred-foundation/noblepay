const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * InvariantRegressions — Named regression tests for every past audit finding
 * and invariant tests verifying critical protocol properties hold under all
 * tested conditions.
 */
describe("InvariantRegressions", function () {

  // ================================================================
  // Shared Fixtures
  // ================================================================

  async function deployMultiSigFixture() {
    const [admin, signer1, signer2, signer3, signer4, signer5, delegate1, recipient, attacker] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Treasury = await ethers.getContractFactory("MultiSigTreasury");
    const treasury = await Treasury.deploy(
      admin.address,
      [signer1.address, signer2.address, signer3.address, signer4.address, signer5.address],
      2, 3, 4, 4 // small:2, medium:3, large:4, emergency:4
    );

    await treasury.connect(admin).setSupportedToken(usdc.target, true);
    await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

    return { treasury, usdc, admin, signer1, signer2, signer3, signer4, signer5, delegate1, recipient, attacker };
  }

  async function deployComplianceOracleFixture() {
    const [admin, manager1, manager2, attacker, nodeOp] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("ComplianceOracle");
    const oracle = await Oracle.deploy(admin.address);

    const THRESHOLD_MANAGER_ROLE = await oracle.THRESHOLD_MANAGER_ROLE();
    await oracle.connect(admin).grantRole(THRESHOLD_MANAGER_ROLE, manager1.address);
    await oracle.connect(admin).grantRole(THRESHOLD_MANAGER_ROLE, manager2.address);

    return { oracle, admin, manager1, manager2, attacker, nodeOp };
  }

  async function deployCrossChainFixture() {
    const [admin, relay1, sender, attacker, treasuryAddr] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Router = await ethers.getContractFactory("CrossChainRouter");
    const router = await Router.deploy(admin.address, treasuryAddr.address);

    await router.connect(admin).setTokenSupport(usdc.target, true);
    await router.connect(admin).addChain(
      137, "Polygon",
      ethers.parseUnits("1", 6),   // baseFee
      50,                            // 0.5% feeRateBP
      32,                            // finalityBlocks
      7200,                          // recoveryTimeout 2 hours
      ethers.parseUnits("10", 6),   // minTransfer
      ethers.parseUnits("1000000", 6) // maxTransfer
    );

    await usdc.mint(sender.address, ethers.parseUnits("100000", 6));
    await usdc.connect(sender).approve(router.target, ethers.MaxUint256);

    return { router, usdc, admin, relay1, sender, attacker, treasuryAddr };
  }

  async function deployPaymentChannelsFixture() {
    const [admin, partyA, partyB, partyC, attacker, treasury] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Channels = await ethers.getContractFactory("PaymentChannels");
    const channels = await Channels.deploy(admin.address, treasury.address, 100); // 1% fee

    await channels.connect(admin).setSupportedToken(usdc.target, true);
    await channels.connect(admin).setKYCStatus(partyA.address, true);
    await channels.connect(admin).setKYCStatus(partyB.address, true);
    await channels.connect(admin).setKYCStatus(partyC.address, true);

    const mintAmount = ethers.parseUnits("1000000", 6);
    await usdc.mint(partyA.address, mintAmount);
    await usdc.mint(partyB.address, mintAmount);
    await usdc.connect(partyA).approve(channels.target, ethers.MaxUint256);
    await usdc.connect(partyB).approve(channels.target, ethers.MaxUint256);

    return { channels, usdc, admin, partyA, partyB, partyC, attacker, treasury };
  }

  async function deployNoblePayFixture() {
    const [admin, treasuryAddr, teeNode, complianceOfficer, businessA, businessB, attacker] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const NoblePay = await ethers.getContractFactory("NoblePay");
    const noblepay = await NoblePay.deploy(admin.address, treasuryAddr.address, 100, 50); // baseFee=100, pctFee=50bp

    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).grantRole(await noblepay.TEE_NODE_ROLE(), teeNode.address);
    await noblepay.connect(admin).grantRole(await noblepay.COMPLIANCE_OFFICER_ROLE(), complianceOfficer.address);
    await noblepay.connect(admin).syncBusiness(businessA.address, 0, true); // STANDARD
    await noblepay.connect(admin).syncBusiness(businessB.address, 0, true);

    await usdc.mint(businessA.address, ethers.parseUnits("1000000", 6));
    await usdc.connect(businessA).approve(noblepay.target, ethers.MaxUint256);

    return { noblepay, usdc, admin, treasuryAddr, teeNode, complianceOfficer, businessA, businessB, attacker };
  }

  // ================================================================
  // NAMED REGRESSIONS FOR PAST FINDINGS
  // ================================================================

  describe("Named Regressions", function () {

    // ──────────────────────────────────────────────────────────────
    // NP-01-regression: delegate resolves to underlying signer
    // ──────────────────────────────────────────────────────────────
    describe("NP-01-regression: delegate resolves to underlying signer", function () {

      it("should resolve delegate approval to the delegator identity, blocking double-vote", async function () {
        const { treasury, usdc, signer1, signer2, delegate1, recipient } =
          await loadFixture(deployMultiSigFixture);

        // signer1 delegates to delegate1
        await treasury.connect(signer1).delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

        // signer1 creates proposal (auto-approves as signer1)
        const tx = await treasury.connect(signer1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("5000", 6),
          0, "NP-01 test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        // delegate1 maps back to signer1 => must revert
        await expect(
          treasury.connect(delegate1).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");

        // Approval count remains 1
        const proposal = await treasury.proposals(proposalId);
        expect(proposal.approvalCount).to.equal(1);
      });

      it("should resolve delegate-created proposal approval to delegator, blocking signer re-approve", async function () {
        const { treasury, usdc, signer1, delegate1, recipient } =
          await loadFixture(deployMultiSigFixture);

        await treasury.connect(signer1).delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

        // delegate creates proposal (auto-approves under signer1's identity)
        const tx = await treasury.connect(delegate1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("5000", 6),
          0, "NP-01 delegate-create test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        // signer1 tries to approve => resolves to same identity => revert
        await expect(
          treasury.connect(signer1).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");
      });

      it("should allow a different signer to approve after delegate creates", async function () {
        const { treasury, usdc, signer1, signer2, delegate1, recipient } =
          await loadFixture(deployMultiSigFixture);

        await treasury.connect(signer1).delegateSigningAuthority(delegate1.address, 7 * 24 * 3600);

        const tx = await treasury.connect(delegate1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("5000", 6),
          0, "NP-01 cross-signer test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        // signer2 is a different identity => should succeed
        await expect(
          treasury.connect(signer2).approveProposal(proposalId)
        ).to.emit(treasury, "ProposalApproved");

        const proposal = await treasury.proposals(proposalId);
        expect(proposal.approvalCount).to.equal(2);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // NP-05-regression: threshold values stored and verified on-chain
    // ──────────────────────────────────────────────────────────────
    describe("NP-05-regression: threshold values stored and verified on-chain", function () {

      it("should store proposed threshold values and reject mismatched approval", async function () {
        const { oracle, manager1, manager2 } = await loadFixture(deployComplianceOracleFixture);

        const proposeTx = await oracle.connect(manager1).proposeThresholdUpdate(35, 75);
        const receipt = await proposeTx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
        const proposalId = event.args[0];

        // Verify proposed values are stored
        const proposed = await oracle.proposedThresholds(proposalId);
        expect(proposed.lowMax).to.equal(35);
        expect(proposed.mediumMax).to.equal(75);
        expect(proposed.exists).to.equal(true);

        // Approve with wrong values => revert
        await expect(
          oracle.connect(manager2).approveThresholdUpdate(proposalId, 99, 100)
        ).to.be.revertedWithCustomError(oracle, "ThresholdValuesMismatch");
      });

      it("should apply stored values when properly approved with matching params", async function () {
        const { oracle, manager1, manager2 } = await loadFixture(deployComplianceOracleFixture);

        const proposeTx = await oracle.connect(manager1).proposeThresholdUpdate(40, 80);
        const receipt = await proposeTx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
        const proposalId = event.args[0];

        await oracle.connect(manager2).approveThresholdUpdate(proposalId, 40, 80);

        const [lowMax, mediumMax] = await oracle.getRiskThresholds();
        expect(lowMax).to.equal(40);
        expect(mediumMax).to.equal(80);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // NP-06-regression: recovery captures original status before mutation
    // ──────────────────────────────────────────────────────────────
    describe("NP-06-regression: recovery captures original status before mutation", function () {

      it("should refund principal + non-protocol fee for INITIATED (never-relayed) transfers", async function () {
        const { router, usdc, sender } = await loadFixture(deployCrossChainFixture);

        const amount = ethers.parseUnits("1000", 6);
        const senderBefore = await usdc.balanceOf(sender.address);

        const tx = await router.connect(sender).initiateTransfer(
          usdc.target, amount, 137,
          ethers.keccak256(ethers.toUtf8Bytes("recipient"))
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
        const transferId = event.args[0];
        const fee = event.args[5];

        const senderAfterInit = await usdc.balanceOf(sender.address);

        await time.increase(7201);
        await router.connect(sender).recoverTransfer(transferId);

        const senderAfterRecover = await usdc.balanceOf(sender.address);
        const refunded = senderAfterRecover - senderAfterInit;

        // refund = principal + fee - protocolFee
        const protocolFee = (fee * 1000n) / 10000n;
        const expectedRefund = amount + fee - protocolFee;
        expect(refunded).to.equal(expectedRefund);
        // Must be strictly more than just principal
        expect(refunded).to.be.gt(amount);
      });

      it("should refund only principal for FAILED transfers (original status captured before mutation)", async function () {
        const { router, usdc, admin, sender } = await loadFixture(deployCrossChainFixture);

        const amount = ethers.parseUnits("500", 6);
        const tx = await router.connect(sender).initiateTransfer(
          usdc.target, amount, 137,
          ethers.keccak256(ethers.toUtf8Bytes("recipient"))
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
        const transferId = event.args[0];

        const senderBeforeRecover = await usdc.balanceOf(sender.address);

        // Mark failed by admin
        await router.connect(admin).markTransferFailed(transferId, "failed relay");

        // Recover failed transfer
        await router.connect(sender).recoverTransfer(transferId);

        const senderAfterRecover = await usdc.balanceOf(sender.address);
        const refunded = senderAfterRecover - senderBeforeRecover;

        // For FAILED, only principal is refunded
        expect(refunded).to.equal(amount);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // NP-11-regression: recurring payment creation requires ADMIN_ROLE
    // ──────────────────────────────────────────────────────────────
    describe("NP-11-regression: recurring payment creation requires ADMIN_ROLE", function () {

      it("should block SIGNER_ROLE (non-admin) from creating recurring payments", async function () {
        const { treasury, usdc, signer1, recipient } = await loadFixture(deployMultiSigFixture);
        const ADMIN_ROLE = await treasury.ADMIN_ROLE();

        await expect(
          treasury.connect(signer1).createRecurringPayment(
            recipient.address, usdc.target, ethers.parseUnits("100", 6),
            0, 0, "unauthorized recurring", 12, ethers.ZeroHash
          )
        ).to.be.revertedWith(
          `AccessControl: account ${signer1.address.toLowerCase()} is missing role ${ADMIN_ROLE}`
        );
      });

      it("should block random attacker from creating recurring payments", async function () {
        const { treasury, usdc, attacker, recipient } = await loadFixture(deployMultiSigFixture);

        await expect(
          treasury.connect(attacker).createRecurringPayment(
            recipient.address, usdc.target, ethers.parseUnits("100", 6),
            0, 0, "attacker recurring", 0, ethers.ZeroHash
          )
        ).to.be.reverted;
      });

      it("should allow ADMIN_ROLE to create recurring payments successfully", async function () {
        const { treasury, usdc, admin, recipient } = await loadFixture(deployMultiSigFixture);

        await expect(
          treasury.connect(admin).createRecurringPayment(
            recipient.address, usdc.target, ethers.parseUnits("100", 6),
            0, 0, "authorized recurring", 12, ethers.ZeroHash
          )
        ).to.emit(treasury, "RecurringPaymentCreated");
      });
    });

    // ──────────────────────────────────────────────────────────────
    // NP-12-regression: batch and single channel use shared validation
    // ──────────────────────────────────────────────────────────────
    describe("NP-12-regression: batch and single channel use shared validation", function () {

      it("should reject batch with challenge period below MIN_CHALLENGE_PERIOD (same as single)", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        const invalidChallenge = 30; // below 1 hour minimum

        // Single channel rejects
        await expect(
          channels.connect(partyA).openChannel(
            partyB.address, usdc.target, ethers.parseUnits("1000", 6),
            invalidChallenge, 100
          )
        ).to.be.revertedWithCustomError(channels, "InvalidChallengePeriod");

        // Batch channel rejects with same error
        await expect(
          channels.connect(partyA).batchOpenChannels(
            [partyB.address], usdc.target, [ethers.parseUnits("1000", 6)],
            invalidChallenge, 100
          )
        ).to.be.revertedWithCustomError(channels, "InvalidChallengePeriod");
      });

      it("should reject batch with challenge period above MAX_CHALLENGE_PERIOD (same as single)", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        const invalidChallenge = 8 * 24 * 3600; // 8 days, above 7 day max

        await expect(
          channels.connect(partyA).openChannel(
            partyB.address, usdc.target, ethers.parseUnits("1000", 6),
            invalidChallenge, 100
          )
        ).to.be.revertedWithCustomError(channels, "InvalidChallengePeriod");

        await expect(
          channels.connect(partyA).batchOpenChannels(
            [partyB.address], usdc.target, [ethers.parseUnits("1000", 6)],
            invalidChallenge, 100
          )
        ).to.be.revertedWithCustomError(channels, "InvalidChallengePeriod");
      });

      it("should reject batch with routing fee above MAX_ROUTING_FEE_BPS (same as single)", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        const invalidFee = 501; // above 500 max

        await expect(
          channels.connect(partyA).openChannel(
            partyB.address, usdc.target, ethers.parseUnits("1000", 6),
            3600, invalidFee
          )
        ).to.be.revertedWithCustomError(channels, "InvalidFee");

        await expect(
          channels.connect(partyA).batchOpenChannels(
            [partyB.address], usdc.target, [ethers.parseUnits("1000", 6)],
            3600, invalidFee
          )
        ).to.be.revertedWithCustomError(channels, "InvalidFee");
      });

      it("should accept batch with valid params at exact boundary values", async function () {
        const { channels, usdc, partyA, partyB, partyC } = await loadFixture(deployPaymentChannelsFixture);

        // MIN_CHALLENGE_PERIOD = 1 hour, MAX_ROUTING_FEE_BPS = 500
        await expect(
          channels.connect(partyA).batchOpenChannels(
            [partyB.address, partyC.address], usdc.target,
            [ethers.parseUnits("1000", 6), ethers.parseUnits("1000", 6)],
            3600, // exactly 1 hour (MIN_CHALLENGE_PERIOD)
            500   // exactly MAX_ROUTING_FEE_BPS
          )
        ).to.emit(channels, "ChannelBatchOpened");
      });
    });
  });

  // ================================================================
  // INVARIANT TESTS
  // ================================================================

  describe("Invariant Tests", function () {

    // ──────────────────────────────────────────────────────────────
    // MultiSigTreasury: total approvals never exceed signer count
    // ──────────────────────────────────────────────────────────────
    describe("MultiSigTreasury: total approvals never exceed signer count", function () {

      it("should cap approvals at signer count even when all signers approve", async function () {
        const { treasury, usdc, signer1, signer2, signer3, signer4, signer5, recipient } =
          await loadFixture(deployMultiSigFixture);

        const config = await treasury.getSignerConfig();
        const totalSigners = config.totalSigners;

        // Create large proposal needing 4 approvals
        const tx = await treasury.connect(signer1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("200000", 6),
          0, "max approval test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        // All other signers approve
        await treasury.connect(signer2).approveProposal(proposalId);
        await treasury.connect(signer3).approveProposal(proposalId);
        await treasury.connect(signer4).approveProposal(proposalId);

        // Proposal is now APPROVED (status = 1)
        const proposalAfter4 = await treasury.proposals(proposalId);
        expect(proposalAfter4.status).to.equal(1); // APPROVED

        // signer5 should not be able to approve an already-approved proposal
        await expect(
          treasury.connect(signer5).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");

        // Final approval count should never exceed total signers
        const finalProposal = await treasury.proposals(proposalId);
        expect(finalProposal.approvalCount).to.be.lte(totalSigners);
      });

      it("should not allow same signer to approve twice, keeping count accurate", async function () {
        const { treasury, usdc, signer1, signer2, recipient } =
          await loadFixture(deployMultiSigFixture);

        const tx = await treasury.connect(signer1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("5000", 6),
          0, "double-approve test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        // signer1 already approved via create; try again
        await expect(
          treasury.connect(signer1).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "AlreadyApproved");

        const proposal = await treasury.proposals(proposalId);
        expect(proposal.approvalCount).to.equal(1);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // MultiSigTreasury: proposal state machine only moves forward
    // ──────────────────────────────────────────────────────────────
    describe("MultiSigTreasury: proposal state machine only moves forward", function () {

      it("PENDING -> APPROVED -> EXECUTED: cannot revert to PENDING", async function () {
        const { treasury, usdc, signer1, signer2, signer3, recipient } =
          await loadFixture(deployMultiSigFixture);

        // Create proposal (PENDING, approvalCount=1)
        const tx = await treasury.connect(signer1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("5000", 6),
          0, "state machine test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        // Verify PENDING
        let proposal = await treasury.proposals(proposalId);
        expect(proposal.status).to.equal(0); // PENDING

        // Approve -> APPROVED
        await treasury.connect(signer2).approveProposal(proposalId);
        proposal = await treasury.proposals(proposalId);
        expect(proposal.status).to.equal(1); // APPROVED

        // Cannot approve again (not PENDING)
        await expect(
          treasury.connect(signer3).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");

        // Wait for timelock, execute -> EXECUTED
        await time.increase(24 * 3600 + 1);
        await treasury.connect(signer1).executeProposal(proposalId);
        proposal = await treasury.proposals(proposalId);
        expect(proposal.status).to.equal(2); // EXECUTED

        // Cannot execute again
        await expect(
          treasury.connect(signer1).executeProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");

        // Cannot approve executed proposal
        await expect(
          treasury.connect(signer3).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");

        // Cannot reject executed proposal
        await expect(
          treasury.connect(signer3).rejectProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");
      });

      it("PENDING -> CANCELLED: cannot approve, reject, or execute cancelled proposals", async function () {
        const { treasury, usdc, signer1, signer2, recipient } =
          await loadFixture(deployMultiSigFixture);

        const tx = await treasury.connect(signer1).createProposal(
          recipient.address, usdc.target, ethers.parseUnits("5000", 6),
          0, "cancel test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        await treasury.connect(signer1).cancelProposal(proposalId);

        const proposal = await treasury.proposals(proposalId);
        expect(proposal.status).to.equal(4); // CANCELLED

        await expect(
          treasury.connect(signer2).approveProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");

        await expect(
          treasury.connect(signer1).executeProposal(proposalId)
        ).to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");
      });
    });

    // ──────────────────────────────────────────────────────────────
    // MultiSigTreasury: executed proposal balance change matches proposal amount
    // ──────────────────────────────────────────────────────────────
    describe("MultiSigTreasury: executed proposal balance change matches proposal amount", function () {

      it("should transfer exactly the proposed amount to recipient upon execution", async function () {
        const { treasury, usdc, signer1, signer2, recipient } =
          await loadFixture(deployMultiSigFixture);

        const amount = ethers.parseUnits("5000", 6);

        const recipientBefore = await usdc.balanceOf(recipient.address);
        const treasuryBefore = await usdc.balanceOf(treasury.target);

        // Create and approve
        const tx = await treasury.connect(signer1).createProposal(
          recipient.address, usdc.target, amount,
          0, "balance test", false, ethers.ZeroHash
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
        const proposalId = event.args[0];

        await treasury.connect(signer2).approveProposal(proposalId);
        await time.increase(24 * 3600 + 1);
        await treasury.connect(signer1).executeProposal(proposalId);

        const recipientAfter = await usdc.balanceOf(recipient.address);
        const treasuryAfter = await usdc.balanceOf(treasury.target);

        // Recipient gained exactly the proposed amount
        expect(recipientAfter - recipientBefore).to.equal(amount);
        // Treasury lost exactly the proposed amount
        expect(treasuryBefore - treasuryAfter).to.equal(amount);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // ComplianceOracle: risk score always 0-100
    // ──────────────────────────────────────────────────────────────
    describe("ComplianceOracle: risk score always 0-100", function () {

      it("should accept risk score 0 (minimum boundary)", async function () {
        const { oracle, nodeOp } = await loadFixture(deployComplianceOracleFixture);

        await oracle.connect(nodeOp).registerTEENode(
          ethers.toUtf8Bytes("pubkey"),
          ethers.keccak256(ethers.toUtf8Bytes("platform")),
          { value: ethers.parseEther("10") }
        );

        await expect(
          oracle.connect(nodeOp).submitScreeningResult(
            ethers.keccak256(ethers.toUtf8Bytes("subject")),
            ethers.keccak256(ethers.toUtf8Bytes("result")),
            0, // minimum valid score
            true
          )
        ).to.emit(oracle, "ScreeningResultSubmitted");
      });

      it("should accept risk score 100 (maximum boundary)", async function () {
        const { oracle, nodeOp } = await loadFixture(deployComplianceOracleFixture);

        await oracle.connect(nodeOp).registerTEENode(
          ethers.toUtf8Bytes("pubkey"),
          ethers.keccak256(ethers.toUtf8Bytes("platform")),
          { value: ethers.parseEther("10") }
        );

        await expect(
          oracle.connect(nodeOp).submitScreeningResult(
            ethers.keccak256(ethers.toUtf8Bytes("subject")),
            ethers.keccak256(ethers.toUtf8Bytes("result")),
            100, // maximum valid score
            true
          )
        ).to.emit(oracle, "ScreeningResultSubmitted");
      });

      it("should reject risk score 101 (one above maximum)", async function () {
        const { oracle, nodeOp } = await loadFixture(deployComplianceOracleFixture);

        await oracle.connect(nodeOp).registerTEENode(
          ethers.toUtf8Bytes("pubkey"),
          ethers.keccak256(ethers.toUtf8Bytes("platform")),
          { value: ethers.parseEther("10") }
        );

        await expect(
          oracle.connect(nodeOp).submitScreeningResult(
            ethers.keccak256(ethers.toUtf8Bytes("subject")),
            ethers.keccak256(ethers.toUtf8Bytes("result")),
            101,
            true
          )
        ).to.be.revertedWithCustomError(oracle, "InvalidRiskScore");
      });

      it("should reject risk score 255 (uint8 max)", async function () {
        const { oracle, nodeOp } = await loadFixture(deployComplianceOracleFixture);

        await oracle.connect(nodeOp).registerTEENode(
          ethers.toUtf8Bytes("pubkey"),
          ethers.keccak256(ethers.toUtf8Bytes("platform")),
          { value: ethers.parseEther("10") }
        );

        await expect(
          oracle.connect(nodeOp).submitScreeningResult(
            ethers.keccak256(ethers.toUtf8Bytes("subject")),
            ethers.keccak256(ethers.toUtf8Bytes("result")),
            255,
            true
          )
        ).to.be.revertedWithCustomError(oracle, "InvalidRiskScore");
      });
    });

    // ──────────────────────────────────────────────────────────────
    // CrossChainRouter: recovered transfer refund never exceeds original deposit + fee
    // ──────────────────────────────────────────────────────────────
    describe("CrossChainRouter: recovered transfer refund never exceeds original deposit + fee", function () {

      it("should ensure refund for INITIATED recovery does not exceed original deposit", async function () {
        const { router, usdc, sender } = await loadFixture(deployCrossChainFixture);

        const amount = ethers.parseUnits("1000", 6);
        const senderBefore = await usdc.balanceOf(sender.address);

        const tx = await router.connect(sender).initiateTransfer(
          usdc.target, amount, 137,
          ethers.keccak256(ethers.toUtf8Bytes("recipient"))
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
        const transferId = event.args[0];
        const fee = event.args[5];

        const totalDeducted = amount + fee;

        await time.increase(7201);

        const recoveryTx = await router.connect(sender).recoverTransfer(transferId);
        const recoveryReceipt = await recoveryTx.wait();
        const recoveryEvent = recoveryReceipt.logs.find(
          l => l.fragment && l.fragment.name === "TransferRecovered"
        );
        const refundAmount = recoveryEvent.args[2];

        // INVARIANT: refund must never exceed what was deposited
        expect(refundAmount).to.be.lte(totalDeducted);

        // Verify sender never ends up with more than they started with
        const senderAfter = await usdc.balanceOf(sender.address);
        expect(senderAfter).to.be.lte(senderBefore);
      });

      it("should ensure refund for FAILED recovery does not exceed principal", async function () {
        const { router, usdc, admin, sender } = await loadFixture(deployCrossChainFixture);

        const amount = ethers.parseUnits("1000", 6);

        const tx = await router.connect(sender).initiateTransfer(
          usdc.target, amount, 137,
          ethers.keccak256(ethers.toUtf8Bytes("recipient"))
        );
        const receipt = await tx.wait();
        const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
        const transferId = event.args[0];
        const fee = event.args[5];

        await router.connect(admin).markTransferFailed(transferId, "relay failed");

        const senderBeforeRecover = await usdc.balanceOf(sender.address);
        await router.connect(sender).recoverTransfer(transferId);
        const senderAfterRecover = await usdc.balanceOf(sender.address);

        const refunded = senderAfterRecover - senderBeforeRecover;

        // INVARIANT: FAILED recovery refunds only principal, never more
        expect(refunded).to.equal(amount);
        expect(refunded).to.be.lte(amount + fee);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // PaymentChannels: channel balance never goes negative
    // ──────────────────────────────────────────────────────────────
    describe("PaymentChannels: channel balance never goes negative", function () {

      it("should reject HTLC creation that would overdraw sender balance", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        // Open channel with 1000 USDC from partyA
        const deposit = ethers.parseUnits("1000", 6);
        const openTx = await channels.connect(partyA).openChannel(
          partyB.address, usdc.target, deposit, 3600, 100
        );
        const openReceipt = await openTx.wait();
        const openEvent = openReceipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
        const channelId = openEvent.args[0];

        // Fund from partyB to make channel ACTIVE
        await channels.connect(partyB).fundChannel(channelId, ethers.parseUnits("500", 6));

        // Try to create HTLC larger than partyA's balance
        const overAmount = ethers.parseUnits("1001", 6);
        await expect(
          channels.connect(partyA).createHTLC(
            channelId, overAmount,
            ethers.keccak256(ethers.toUtf8Bytes("secret")),
            (await ethers.provider.getBlock("latest")).timestamp + 7200
          )
        ).to.be.revertedWithCustomError(channels, "InsufficientDeposit");
      });

      it("should allow HTLC creation up to exact balance", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        const deposit = ethers.parseUnits("1000", 6);
        const openTx = await channels.connect(partyA).openChannel(
          partyB.address, usdc.target, deposit, 3600, 100
        );
        const openReceipt = await openTx.wait();
        const openEvent = openReceipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
        const channelId = openEvent.args[0];

        await channels.connect(partyB).fundChannel(channelId, ethers.parseUnits("500", 6));

        // HTLC for exactly the balance should succeed
        await expect(
          channels.connect(partyA).createHTLC(
            channelId, deposit,
            ethers.keccak256(ethers.toUtf8Bytes("secret")),
            (await ethers.provider.getBlock("latest")).timestamp + 7200
          )
        ).to.emit(channels, "HTLCCreated");

        // After creating HTLC for full balance, partyA's balance should be 0
        const ch = await channels.getChannel(channelId);
        expect(ch.balanceA).to.equal(0);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // PaymentChannels: channel cannot be closed during active dispute
    // ──────────────────────────────────────────────────────────────
    describe("PaymentChannels: channel cannot be closed during active dispute", function () {

      it("should block finalizeClose before challenge period expires", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        const deposit = ethers.parseUnits("1000", 6);
        const challengePeriod = 24 * 3600; // 24 hours

        // Open and fund channel
        const openTx = await channels.connect(partyA).openChannel(
          partyB.address, usdc.target, deposit, challengePeriod, 100
        );
        const openReceipt = await openTx.wait();
        const openEvent = openReceipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
        const channelId = openEvent.args[0];

        await channels.connect(partyB).fundChannel(channelId, ethers.parseUnits("500", 6));

        // Sign a state for unilateral close
        const balA = ethers.parseUnits("800", 6);
        const balB = ethers.parseUnits("700", 6);
        const nonce = 1;

        const stateHash = ethers.keccak256(
          ethers.solidityPacked(
            ["bytes32", "uint256", "uint256", "uint256", "string"],
            [channelId, balA, balB, nonce, "STATE"]
          )
        );
        const signatureB = await partyB.signMessage(ethers.getBytes(stateHash));

        // partyA initiates unilateral close
        await channels.connect(partyA).initiateUnilateralClose(
          channelId, balA, balB, nonce, signatureB
        );

        // Immediately try to finalize => should fail (challenge period active)
        await expect(
          channels.connect(partyA).finalizeClose(channelId)
        ).to.be.revertedWithCustomError(channels, "ChallengeNotExpired");

        // After challenge period, finalize should work
        await time.increase(challengePeriod + 1);
        await expect(
          channels.connect(partyA).finalizeClose(channelId)
        ).to.emit(channels, "DisputeResolved");
      });

      it("should block cooperative close on a channel already in CLOSING state", async function () {
        const { channels, usdc, partyA, partyB } = await loadFixture(deployPaymentChannelsFixture);

        const deposit = ethers.parseUnits("1000", 6);

        const openTx = await channels.connect(partyA).openChannel(
          partyB.address, usdc.target, deposit, 3600, 100
        );
        const openReceipt = await openTx.wait();
        const openEvent = openReceipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
        const channelId = openEvent.args[0];

        await channels.connect(partyB).fundChannel(channelId, ethers.parseUnits("500", 6));

        // Initiate unilateral close
        const balA = ethers.parseUnits("800", 6);
        const balB = ethers.parseUnits("700", 6);
        const nonce = 1;

        const stateHash = ethers.keccak256(
          ethers.solidityPacked(
            ["bytes32", "uint256", "uint256", "uint256", "string"],
            [channelId, balA, balB, nonce, "STATE"]
          )
        );
        const signatureB = await partyB.signMessage(ethers.getBytes(stateHash));
        await channels.connect(partyA).initiateUnilateralClose(
          channelId, balA, balB, nonce, signatureB
        );

        // Channel is now CLOSING; try cooperative close => should fail
        const closeHash = ethers.keccak256(
          ethers.solidityPacked(
            ["bytes32", "uint256", "uint256", "uint256", "string"],
            [channelId, balA, balB, 2, "CLOSE"]
          )
        );
        const sigA = await partyA.signMessage(ethers.getBytes(closeHash));
        const sigB = await partyB.signMessage(ethers.getBytes(closeHash));

        await expect(
          channels.connect(partyA).cooperativeClose(channelId, balA, balB, 2, sigA, sigB)
        ).to.be.revertedWithCustomError(channels, "InvalidChannelStatus");
      });
    });
  });

  // ================================================================
  // DEPLOYMENT CONFIG SAFETY
  // ================================================================

  describe("Deployment Config Safety", function () {

    // ──────────────────────────────────────────────────────────────
    // All role assignments use correct addresses
    // ──────────────────────────────────────────────────────────────
    describe("All role assignments use correct addresses", function () {

      it("MultiSigTreasury: admin has ADMIN_ROLE and DEFAULT_ADMIN_ROLE", async function () {
        const { treasury, admin } = await loadFixture(deployMultiSigFixture);

        expect(await treasury.hasRole(await treasury.ADMIN_ROLE(), admin.address)).to.be.true;
        expect(await treasury.hasRole(await treasury.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
      });

      it("MultiSigTreasury: all signers have SIGNER_ROLE", async function () {
        const { treasury, signer1, signer2, signer3, signer4, signer5 } =
          await loadFixture(deployMultiSigFixture);

        const SIGNER_ROLE = await treasury.SIGNER_ROLE();
        expect(await treasury.hasRole(SIGNER_ROLE, signer1.address)).to.be.true;
        expect(await treasury.hasRole(SIGNER_ROLE, signer2.address)).to.be.true;
        expect(await treasury.hasRole(SIGNER_ROLE, signer3.address)).to.be.true;
        expect(await treasury.hasRole(SIGNER_ROLE, signer4.address)).to.be.true;
        expect(await treasury.hasRole(SIGNER_ROLE, signer5.address)).to.be.true;
      });

      it("MultiSigTreasury: attacker does not have any privileged roles", async function () {
        const { treasury, attacker } = await loadFixture(deployMultiSigFixture);

        expect(await treasury.hasRole(await treasury.ADMIN_ROLE(), attacker.address)).to.be.false;
        expect(await treasury.hasRole(await treasury.SIGNER_ROLE(), attacker.address)).to.be.false;
        expect(await treasury.hasRole(await treasury.DEFAULT_ADMIN_ROLE(), attacker.address)).to.be.false;
      });

      it("ComplianceOracle: admin has all management roles", async function () {
        const { oracle, admin } = await loadFixture(deployComplianceOracleFixture);

        expect(await oracle.hasRole(await oracle.ADMIN_ROLE(), admin.address)).to.be.true;
        expect(await oracle.hasRole(await oracle.TEE_MANAGER_ROLE(), admin.address)).to.be.true;
        expect(await oracle.hasRole(await oracle.THRESHOLD_MANAGER_ROLE(), admin.address)).to.be.true;
      });

      it("CrossChainRouter: admin has ROUTER_ADMIN_ROLE", async function () {
        const { router, admin } = await loadFixture(deployCrossChainFixture);

        expect(await router.hasRole(await router.ROUTER_ADMIN_ROLE(), admin.address)).to.be.true;
      });

      it("PaymentChannels: admin has ADMIN_ROLE", async function () {
        const { channels, admin } = await loadFixture(deployPaymentChannelsFixture);

        expect(await channels.hasRole(await channels.ADMIN_ROLE(), admin.address)).to.be.true;
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Fee percentages within sane bounds (0-10%)
    // ──────────────────────────────────────────────────────────────
    describe("Fee percentages within sane bounds (0-10%)", function () {

      it("NoblePay: MAX_PERCENTAGE_FEE is 500bp (5%)", async function () {
        const { noblepay } = await loadFixture(deployNoblePayFixture);
        const maxFee = await noblepay.MAX_PERCENTAGE_FEE();
        expect(maxFee).to.equal(500);
        expect(maxFee).to.be.lte(1000); // at most 10%
      });

      it("NoblePay: rejects fee above MAX_PERCENTAGE_FEE", async function () {
        const { noblepay, admin } = await loadFixture(deployNoblePayFixture);
        await expect(
          noblepay.connect(admin).setFees(0, 501) // above 500 cap
        ).to.be.revertedWithCustomError(noblepay, "InvalidFee");
      });

      it("NoblePay: accepts fee at exactly MAX_PERCENTAGE_FEE", async function () {
        const { noblepay, admin } = await loadFixture(deployNoblePayFixture);
        await expect(
          noblepay.connect(admin).setFees(0, 500) // exactly at cap
        ).to.emit(noblepay, "FeeUpdated");
      });

      it("CrossChainRouter: MAX_FEE_RATE_BP is 200bp (2%)", async function () {
        const { router } = await loadFixture(deployCrossChainFixture);
        const maxFee = await router.MAX_FEE_RATE_BP();
        expect(maxFee).to.equal(200);
        expect(maxFee).to.be.lte(1000);
      });

      it("CrossChainRouter: rejects chain with fee above MAX_FEE_RATE_BP", async function () {
        const { router, admin } = await loadFixture(deployCrossChainFixture);
        await expect(
          router.connect(admin).addChain(
            56, "BSC", 0, 201, 15, 7200,
            ethers.parseUnits("10", 6),
            ethers.parseUnits("1000000", 6)
          )
        ).to.be.revertedWithCustomError(router, "InvalidFeeRate");
      });

      it("PaymentChannels: protocolFeeBps capped at 500bp (5%) in constructor", async function () {
        const [admin, treasury] = await ethers.getSigners();
        const Channels = await ethers.getContractFactory("PaymentChannels");

        await expect(
          Channels.deploy(admin.address, treasury.address, 501)
        ).to.be.revertedWithCustomError(Channels, "InvalidFee");

        // 500 should work
        const ch = await Channels.deploy(admin.address, treasury.address, 500);
        expect(await ch.protocolFeeBps()).to.equal(500);
      });

      it("PaymentChannels: MAX_ROUTING_FEE_BPS is 500bp (5%)", async function () {
        const { channels } = await loadFixture(deployPaymentChannelsFixture);
        const maxFee = await channels.MAX_ROUTING_FEE_BPS();
        expect(maxFee).to.equal(500);
        expect(maxFee).to.be.lte(1000);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Timelock durations within sane bounds (1 hour - 30 days)
    // ──────────────────────────────────────────────────────────────
    describe("Timelock durations within sane bounds (1 hour - 30 days)", function () {

      it("MultiSigTreasury: EMERGENCY_TIMELOCK is 1 hour", async function () {
        const { treasury } = await loadFixture(deployMultiSigFixture);
        const emergencyTimelock = await treasury.EMERGENCY_TIMELOCK();
        expect(emergencyTimelock).to.equal(3600); // 1 hour
        expect(emergencyTimelock).to.be.gte(3600);
      });

      it("MultiSigTreasury: STANDARD_TIMELOCK is 24 hours", async function () {
        const { treasury } = await loadFixture(deployMultiSigFixture);
        const standardTimelock = await treasury.STANDARD_TIMELOCK();
        expect(standardTimelock).to.equal(24 * 3600);
        expect(standardTimelock).to.be.gte(3600); // >= 1 hour
        expect(standardTimelock).to.be.lte(30 * 24 * 3600); // <= 30 days
      });

      it("MultiSigTreasury: LARGE_TIMELOCK is 48 hours", async function () {
        const { treasury } = await loadFixture(deployMultiSigFixture);
        const largeTimelock = await treasury.LARGE_TIMELOCK();
        expect(largeTimelock).to.equal(48 * 3600);
        expect(largeTimelock).to.be.gte(3600);
        expect(largeTimelock).to.be.lte(30 * 24 * 3600);
      });

      it("MultiSigTreasury: PROPOSAL_EXPIRY is 7 days", async function () {
        const { treasury } = await loadFixture(deployMultiSigFixture);
        const expiry = await treasury.PROPOSAL_EXPIRY();
        expect(expiry).to.equal(7 * 24 * 3600);
        expect(expiry).to.be.lte(30 * 24 * 3600);
      });

      it("MultiSigTreasury: MAX_DELEGATION_PERIOD is 30 days", async function () {
        const { treasury } = await loadFixture(deployMultiSigFixture);
        const maxDelegation = await treasury.MAX_DELEGATION_PERIOD();
        expect(maxDelegation).to.equal(30 * 24 * 3600);
      });

      it("CrossChainRouter: MIN_RECOVERY_TIMEOUT is 2 hours", async function () {
        const { router } = await loadFixture(deployCrossChainFixture);
        const minTimeout = await router.MIN_RECOVERY_TIMEOUT();
        expect(minTimeout).to.equal(2 * 3600);
        expect(minTimeout).to.be.gte(3600);
      });

      it("CrossChainRouter: rejects chain with recovery timeout below minimum", async function () {
        const { router, admin } = await loadFixture(deployCrossChainFixture);
        await expect(
          router.connect(admin).addChain(
            56, "BSC", 0, 50, 15, 3599, // 3599s < 2 hours
            ethers.parseUnits("10", 6),
            ethers.parseUnits("1000000", 6)
          )
        ).to.be.revertedWithCustomError(router, "InvalidRecoveryTimeout");
      });

      it("PaymentChannels: challenge period bounds are 1 hour - 7 days", async function () {
        const { channels } = await loadFixture(deployPaymentChannelsFixture);
        const minChallenge = await channels.MIN_CHALLENGE_PERIOD();
        const maxChallenge = await channels.MAX_CHALLENGE_PERIOD();
        expect(minChallenge).to.equal(3600);
        expect(maxChallenge).to.equal(7 * 24 * 3600);
        expect(minChallenge).to.be.gte(3600);
        expect(maxChallenge).to.be.lte(30 * 24 * 3600);
      });
    });

    // ──────────────────────────────────────────────────────────────
    // Zero-address checks on all critical parameters
    // ──────────────────────────────────────────────────────────────
    describe("Zero-address checks on all critical parameters", function () {

      it("MultiSigTreasury: rejects zero-address admin in constructor", async function () {
        const [_, signer1, signer2] = await ethers.getSigners();
        const Treasury = await ethers.getContractFactory("MultiSigTreasury");

        await expect(
          Treasury.deploy(ethers.ZeroAddress, [signer1.address, signer2.address], 1, 1, 2, 2)
        ).to.be.revertedWithCustomError(Treasury, "ZeroAddress");
      });

      it("MultiSigTreasury: rejects zero-address signer in constructor", async function () {
        const [admin, signer1] = await ethers.getSigners();
        const Treasury = await ethers.getContractFactory("MultiSigTreasury");

        await expect(
          Treasury.deploy(admin.address, [signer1.address, ethers.ZeroAddress], 1, 1, 2, 2)
        ).to.be.revertedWithCustomError(Treasury, "ZeroAddress");
      });

      it("MultiSigTreasury: rejects zero-address recipient in proposal", async function () {
        const { treasury, usdc, signer1 } = await loadFixture(deployMultiSigFixture);

        await expect(
          treasury.connect(signer1).createProposal(
            ethers.ZeroAddress, usdc.target, ethers.parseUnits("1000", 6),
            0, "zero addr test", false, ethers.ZeroHash
          )
        ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
      });

      it("ComplianceOracle: rejects zero-address admin in constructor", async function () {
        const Oracle = await ethers.getContractFactory("ComplianceOracle");
        await expect(
          Oracle.deploy(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(Oracle, "ZeroAddress");
      });

      it("CrossChainRouter: rejects zero-address admin in constructor", async function () {
        const [_, treasuryAddr] = await ethers.getSigners();
        const Router = await ethers.getContractFactory("CrossChainRouter");
        await expect(
          Router.deploy(ethers.ZeroAddress, treasuryAddr.address)
        ).to.be.revertedWithCustomError(Router, "ZeroAddress");
      });

      it("CrossChainRouter: rejects zero-address treasury in constructor", async function () {
        const [admin] = await ethers.getSigners();
        const Router = await ethers.getContractFactory("CrossChainRouter");
        await expect(
          Router.deploy(admin.address, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(Router, "ZeroAddress");
      });

      it("CrossChainRouter: rejects zero-address on setTreasury", async function () {
        const { router, admin } = await loadFixture(deployCrossChainFixture);
        await expect(
          router.connect(admin).setTreasury(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(router, "ZeroAddress");
      });

      it("CrossChainRouter: rejects zero-address on setTokenSupport", async function () {
        const { router, admin } = await loadFixture(deployCrossChainFixture);
        await expect(
          router.connect(admin).setTokenSupport(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(router, "ZeroAddress");
      });

      it("PaymentChannels: rejects zero-address admin in constructor", async function () {
        const [_, treasury] = await ethers.getSigners();
        const Channels = await ethers.getContractFactory("PaymentChannels");
        await expect(
          Channels.deploy(ethers.ZeroAddress, treasury.address, 100)
        ).to.be.revertedWithCustomError(Channels, "ZeroAddress");
      });

      it("PaymentChannels: rejects zero-address treasury in constructor", async function () {
        const [admin] = await ethers.getSigners();
        const Channels = await ethers.getContractFactory("PaymentChannels");
        await expect(
          Channels.deploy(admin.address, ethers.ZeroAddress, 100)
        ).to.be.revertedWithCustomError(Channels, "ZeroAddress");
      });

      it("NoblePay: rejects zero-address admin in constructor", async function () {
        const [_, treasury] = await ethers.getSigners();
        const NP = await ethers.getContractFactory("NoblePay");
        await expect(
          NP.deploy(ethers.ZeroAddress, treasury.address, 100, 50)
        ).to.be.revertedWithCustomError(NP, "ZeroAddress");
      });

      it("NoblePay: rejects zero-address treasury in constructor", async function () {
        const [admin] = await ethers.getSigners();
        const NP = await ethers.getContractFactory("NoblePay");
        await expect(
          NP.deploy(admin.address, ethers.ZeroAddress, 100, 50)
        ).to.be.revertedWithCustomError(NP, "ZeroAddress");
      });

      it("NoblePay: rejects zero-address on setSupportedToken", async function () {
        const { noblepay, admin } = await loadFixture(deployNoblePayFixture);
        await expect(
          noblepay.connect(admin).setSupportedToken(ethers.ZeroAddress, true)
        ).to.be.revertedWithCustomError(noblepay, "ZeroAddress");
      });

      it("NoblePay: rejects zero-address on setTreasury", async function () {
        const { noblepay, admin } = await loadFixture(deployNoblePayFixture);
        await expect(
          noblepay.connect(admin).setTreasury(ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(noblepay, "ZeroAddress");
      });
    });
  });
});
