const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("MultiSigTreasury - Coverage", function () {
  async function deployFixture() {
    const [admin, signer1, signer2, signer3, signer4, signer5, budgetMgr, yieldMgr, recipient, delegate, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Treasury = await ethers.getContractFactory("MultiSigTreasury");
    const treasury = await Treasury.deploy(
      admin.address,
      [signer1.address, signer2.address, signer3.address, signer4.address, signer5.address],
      2, 3, 4, 4
    );

    await treasury.connect(admin).grantRole(await treasury.BUDGET_MANAGER_ROLE(), budgetMgr.address);
    await treasury.connect(admin).grantRole(await treasury.YIELD_MANAGER_ROLE(), yieldMgr.address);
    await treasury.connect(admin).setSupportedToken(usdc.target, true);
    await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

    return { treasury, usdc, admin, signer1, signer2, signer3, signer4, signer5, budgetMgr, yieldMgr, recipient, delegate, other };
  }

  describe("Constructor Edge Cases", function () {
    it("should revert with zero signer address in array", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, s1] = await ethers.getSigners();
      await expect(Treasury.deploy(admin.address, [s1.address, ethers.ZeroAddress], 1, 1, 2, 2))
        .to.be.revertedWithCustomError(Treasury, "ZeroAddress");
    });

    it("should revert with small threshold = 0", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, s1, s2] = await ethers.getSigners();
      await expect(Treasury.deploy(admin.address, [s1.address, s2.address], 0, 1, 2, 2))
        .to.be.revertedWithCustomError(Treasury, "InvalidSignerConfig");
    });

    it("should revert with small > medium threshold", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, s1, s2] = await ethers.getSigners();
      await expect(Treasury.deploy(admin.address, [s1.address, s2.address], 2, 1, 2, 2))
        .to.be.revertedWithCustomError(Treasury, "InvalidSignerConfig");
    });

    it("should revert with medium > large threshold", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, s1, s2, s3] = await ethers.getSigners();
      await expect(Treasury.deploy(admin.address, [s1.address, s2.address, s3.address], 1, 3, 2, 2))
        .to.be.revertedWithCustomError(Treasury, "InvalidSignerConfig");
    });
  });

  describe("Medium Tier Proposals", function () {
    it("should classify medium tier ($10K-$100K)", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      const mediumAmount = ethers.parseUnits("50000", 6); // $50K
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, mediumAmount, 0, "medium payment", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      expect(event.args.tier).to.equal(1); // MEDIUM
    });

    it("should require 3 approvals for medium tier", async function () {
      const { treasury, usdc, signer1, signer2, signer3, recipient } = await loadFixture(deployFixture);
      const mediumAmount = ethers.parseUnits("50000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, mediumAmount, 0, "medium", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // signer1 already approved (auto), signer2 approves
      await treasury.connect(signer2).approveProposal(proposalId);
      let prop = await treasury.proposals(proposalId);
      expect(prop.status).to.equal(0); // Still PENDING (need 3)

      await treasury.connect(signer3).approveProposal(proposalId);
      prop = await treasury.proposals(proposalId);
      expect(prop.status).to.equal(1); // APPROVED
    });
  });

  describe("Emergency Proposals", function () {
    it("should create emergency proposal with fast-track timelock", async function () {
      const { treasury, usdc, signer1, signer2, signer3, signer4, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("5000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 0, "emergency", true, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];
      expect(event.args.tier).to.equal(3); // EMERGENCY

      // Approve with 4 signers
      await treasury.connect(signer2).approveProposal(proposalId);
      await treasury.connect(signer3).approveProposal(proposalId);
      await treasury.connect(signer4).approveProposal(proposalId);

      // Only 1 hour timelock for emergency
      await time.increase(3601);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.emit(treasury, "ProposalExecuted");
    });
  });

  describe("Proposal Rejection Threshold", function () {
    it("should auto-reject when rejection threshold is met", async function () {
      const { treasury, usdc, signer1, signer2, signer3, signer4, signer5, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("5000", 6); // small tier, needs 2 approvals
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      // Reject threshold = totalSigners - requiredApprovals + 1 = 5 - 2 + 1 = 4
      await treasury.connect(signer2).rejectProposal(proposalId);
      await treasury.connect(signer3).rejectProposal(proposalId);
      await treasury.connect(signer4).rejectProposal(proposalId);
      let prop = await treasury.proposals(proposalId);
      expect(prop.status).to.equal(0); // still PENDING

      await treasury.connect(signer5).rejectProposal(proposalId);
      prop = await treasury.proposals(proposalId);
      expect(prop.status).to.equal(3); // REJECTED
    });

    it("should revert duplicate rejection", async function () {
      const { treasury, usdc, signer1, signer2, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).rejectProposal(proposalId);
      await expect(treasury.connect(signer2).rejectProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "AlreadyRejected");
    });
  });

  describe("Proposal Execution - Native Tokens", function () {
    it("should execute proposal with native tokens", async function () {
      const { treasury, signer1, signer2, recipient, admin } = await loadFixture(deployFixture);
      // Fund treasury with native tokens
      await admin.sendTransaction({ to: treasury.target, value: ethers.parseEther("10") });

      // Use amount below SMALL_TX_THRESHOLD (10_000 * 1e6 = 1e10)
      const amount = 5000n * 1000000n; // $5K in 6-decimal terms
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, ethers.ZeroAddress, amount, 0, "native payment", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);

      const balBefore = await ethers.provider.getBalance(recipient.address);
      await treasury.connect(signer1).executeProposal(proposalId);
      const balAfter = await ethers.provider.getBalance(recipient.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it("should revert native execution with insufficient balance", async function () {
      const { treasury, signer1, signer2, recipient } = await loadFixture(deployFixture);
      // Amount below SMALL threshold so only 2 approvals needed, but treasury won't have enough native
      const amount = 5000n * 1000000n;
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, ethers.ZeroAddress, amount, 0, "too much", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });
  });

  describe("Proposal Execution with Budget", function () {
    it("should execute proposal linked to a budget", async function () {
      const { treasury, usdc, signer1, signer2, budgetMgr, recipient } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const budgetTx = await treasury.connect(budgetMgr).createBudget(
        "Engineering", 5, ethers.parseUnits("1000000", 6),
        ethers.parseUnits("50000", 6), ethers.parseUnits("200000", 6),
        ethers.parseUnits("500000", 6), periodEnd
      );
      const budgetReceipt = await budgetTx.wait();
      const budgetEvent = budgetReceipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = budgetEvent.args[0];

      const amount = ethers.parseUnits("5000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 5, "from budget", false, budgetId
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.emit(treasury, "ProposalExecuted");

      const budget = await treasury.getBudget(budgetId);
      expect(budget.spent).to.equal(amount);
    });
  });

  describe("Proposal Expiry", function () {
    it("should revert execution after proposal expires", async function () {
      const { treasury, usdc, signer1, signer2, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("5000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, amount, 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      // Fast forward past expiry (typically 7 days)
      await time.increase(7 * 24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "ProposalExpiredError");
    });
  });

  describe("Cancel Proposal", function () {
    it("should allow admin to cancel a proposal", async function () {
      const { treasury, usdc, signer1, admin, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await expect(treasury.connect(admin).cancelProposal(proposalId))
        .to.emit(treasury, "ProposalCancelled");
    });

    it("should allow cancel of approved proposal", async function () {
      const { treasury, usdc, signer1, signer2, admin, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await expect(treasury.connect(admin).cancelProposal(proposalId))
        .to.emit(treasury, "ProposalCancelled");
    });

    it("should revert cancel by unauthorized", async function () {
      const { treasury, usdc, signer1, other, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await expect(treasury.connect(other).cancelProposal(proposalId))
        .to.be.revertedWith("MultiSigTreasury: not authorized to cancel");
    });

    it("should revert cancel of executed proposal", async function () {
      const { treasury, usdc, signer1, signer2, admin, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);
      await treasury.connect(signer1).executeProposal(proposalId);

      await expect(treasury.connect(admin).cancelProposal(proposalId))
        .to.be.revertedWith("MultiSigTreasury: cannot cancel");
    });
  });

  describe("Recurring Payments - Native & Budget", function () {
    it("should execute recurring payment with native tokens", async function () {
      const { treasury, signer1, recipient, admin } = await loadFixture(deployFixture);
      await admin.sendTransaction({ to: treasury.target, value: ethers.parseEther("10") });

      const amount = ethers.parseEther("0.1");
      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, ethers.ZeroAddress, amount, 0, 0, "daily native", 12, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      await time.increase(24 * 3600 + 1);
      const balBefore = await ethers.provider.getBalance(recipient.address);
      await treasury.connect(signer1).executeRecurringPayment(paymentId);
      const balAfter = await ethers.provider.getBalance(recipient.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it("should execute recurring payment linked to budget", async function () {
      const { treasury, usdc, admin, signer1, budgetMgr, recipient } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const budgetTx = await treasury.connect(budgetMgr).createBudget(
        "Payroll", 1, ethers.parseUnits("1000000", 6),
        ethers.parseUnits("50000", 6), ethers.parseUnits("200000", 6),
        ethers.parseUnits("500000", 6), periodEnd
      );
      const budgetReceipt = await budgetTx.wait();
      const budgetEvent = budgetReceipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = budgetEvent.args[0];

      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6), 3, 1, "monthly salary", 12, budgetId
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      await time.increase(31 * 24 * 3600);
      await treasury.connect(signer1).executeRecurringPayment(paymentId);

      const budget = await treasury.getBudget(budgetId);
      expect(budget.spent).to.equal(ethers.parseUnits("1000", 6));
    });

    it("should revert when max executions reached", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("100", 6), 0, 0, "daily", 1, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      await time.increase(24 * 3600 + 1);
      await treasury.connect(signer1).executeRecurringPayment(paymentId);

      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeRecurringPayment(paymentId))
        .to.be.revertedWithCustomError(treasury, "MaxExecutionsReached");
    });

    it("should create recurring payment with BIWEEKLY frequency", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6), 2, 0, "biweekly", 0, ethers.ZeroHash
      )).to.emit(treasury, "RecurringPaymentCreated");
    });

    it("should create recurring payment with QUARTERLY frequency", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6), 4, 0, "quarterly", 0, ethers.ZeroHash
      )).to.emit(treasury, "RecurringPaymentCreated");
    });
  });

  describe("Yield Management", function () {
    it("should allocate funds to approved yield protocol", async function () {
      const { treasury, usdc, admin, yieldMgr, other } = await loadFixture(deployFixture);
      await treasury.connect(admin).approveYieldProtocol(
        other.address, "Aave", ethers.parseUnits("1000000", 6)
      );

      const amount = ethers.parseUnits("50000", 6);
      await expect(treasury.connect(yieldMgr).allocateToYield(other.address, usdc.target, amount))
        .to.emit(treasury, "YieldAllocated");
    });

    it("should revert allocation to unapproved protocol", async function () {
      const { treasury, usdc, yieldMgr, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(yieldMgr).allocateToYield(other.address, usdc.target, 1000))
        .to.be.revertedWithCustomError(treasury, "ProtocolNotApproved");
    });

    it("should revert allocation exceeding max", async function () {
      const { treasury, usdc, admin, yieldMgr, other } = await loadFixture(deployFixture);
      await treasury.connect(admin).approveYieldProtocol(
        other.address, "Aave", ethers.parseUnits("1000", 6)
      );
      await expect(treasury.connect(yieldMgr).allocateToYield(
        other.address, usdc.target, ethers.parseUnits("2000", 6)
      )).to.be.revertedWithCustomError(treasury, "AllocationExceeded");
    });

    it("should revert zero amount allocation", async function () {
      const { treasury, usdc, admin, yieldMgr, other } = await loadFixture(deployFixture);
      await treasury.connect(admin).approveYieldProtocol(
        other.address, "Aave", ethers.parseUnits("1000000", 6)
      );
      await expect(treasury.connect(yieldMgr).allocateToYield(other.address, usdc.target, 0))
        .to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });
  });

  describe("Signer Management", function () {
    it("should add and remove a signer", async function () {
      const { treasury, admin, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).addSigner(other.address))
        .to.emit(treasury, "SignerAdded");

      const config = await treasury.signerConfig();
      expect(config.totalSigners).to.equal(6);

      await expect(treasury.connect(admin).removeSigner(other.address))
        .to.emit(treasury, "SignerRemoved");

      const config2 = await treasury.signerConfig();
      expect(config2.totalSigners).to.equal(5);
    });

    it("should revert adding existing signer", async function () {
      const { treasury, admin, signer1 } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).addSigner(signer1.address))
        .to.be.revertedWithCustomError(treasury, "SignerAlreadyExists");
    });

    it("should revert adding zero address signer", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).addSigner(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("should revert removing non-signer", async function () {
      const { treasury, admin, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).removeSigner(other.address))
        .to.be.revertedWithCustomError(treasury, "NotSigner");
    });

    it("should revert removing signer below threshold", async function () {
      const { treasury, admin, signer1, signer2 } = await loadFixture(deployFixture);
      // Remove until we can't anymore (totalSigners <= largeThreshold)
      await treasury.connect(admin).removeSigner(signer1.address);
      await expect(treasury.connect(admin).removeSigner(signer2.address))
        .to.be.revertedWithCustomError(treasury, "MinimumSignersRequired");
    });

    it("should remove a signer that is not the last in array (swap-and-pop)", async function () {
      const { treasury, admin, signer1, signer2, other } = await loadFixture(deployFixture);
      // Add extra signer to ensure we can remove
      await treasury.connect(admin).addSigner(other.address);
      // Remove signer1 which is in the middle
      await treasury.connect(admin).removeSigner(signer1.address);
      const signers = await treasury.getSigners();
      expect(signers).to.not.include(signer1.address);
    });
  });

  describe("Update Signer Config", function () {
    it("should update signer config", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).updateSignerConfig(1, 2, 3, 3))
        .to.emit(treasury, "SignerConfigUpdated");
    });

    it("should revert invalid signer config update", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).updateSignerConfig(0, 2, 3, 3))
        .to.be.revertedWithCustomError(treasury, "InvalidSignerConfig");
    });

    it("should revert when large > totalSigners", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).updateSignerConfig(1, 2, 6, 6))
        .to.be.revertedWithCustomError(treasury, "InvalidSignerConfig");
    });
  });

  describe("View Functions", function () {
    it("should return proposal via getProposal", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      const proposal = await treasury.getProposal(proposalId);
      expect(proposal.proposer).to.equal(signer1.address);
    });

    it("should return budget via getBudget", async function () {
      const { treasury, budgetMgr } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const tx = await treasury.connect(budgetMgr).createBudget(
        "Eng", 0, ethers.parseUnits("1000000", 6), 0, 0, 0, periodEnd
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = event.args[0];

      const budget = await treasury.getBudget(budgetId);
      expect(budget.name).to.equal("Eng");
    });

    it("should return spending tracker", async function () {
      const { treasury, budgetMgr } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const tx = await treasury.connect(budgetMgr).createBudget(
        "Test", 0, ethers.parseUnits("100000", 6), 0, 0, 0, periodEnd
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = event.args[0];

      const tracker = await treasury.getSpendingTracker(budgetId);
      expect(tracker.dailySpent).to.equal(0);
    });

    it("should return recurring payment record", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, 1000, 0, 0, "daily", 0, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      const rp = await treasury.getRecurringPayment(paymentId);
      expect(rp.recipient).to.equal(recipient.address);
    });

    it("should return signer list", async function () {
      const { treasury } = await loadFixture(deployFixture);
      const signers = await treasury.getSigners();
      expect(signers.length).to.equal(5);
    });

    it("should return signer config", async function () {
      const { treasury } = await loadFixture(deployFixture);
      const config = await treasury.getSignerConfig();
      expect(config.smallThreshold).to.equal(2);
    });

    it("should check hasApproved", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      expect(await treasury.hasApproved(proposalId, signer1.address)).to.be.true;
    });

    it("should return active budgets", async function () {
      const { treasury, budgetMgr } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      await treasury.connect(budgetMgr).createBudget(
        "Test1", 0, ethers.parseUnits("100000", 6), 0, 0, 0, periodEnd
      );
      const budgets = await treasury.getActiveBudgets();
      expect(budgets.length).to.be.greaterThan(0);
    });
  });

  describe("Admin - setNoblePayContract", function () {
    it("should set NoblePay contract", async function () {
      const { treasury, admin, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).setNoblePayContract(other.address))
        .to.emit(treasury, "NoblePayUpdated");
    });

    it("should revert for zero address", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).setNoblePayContract(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });

  describe("Budget Spending Limits", function () {
    it("should enforce daily spending limit on execute", async function () {
      const { treasury, usdc, signer1, signer2, budgetMgr, recipient } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const dailyLimit = ethers.parseUnits("4000", 6);
      const budgetTx = await treasury.connect(budgetMgr).createBudget(
        "Limited", 0, ethers.parseUnits("1000000", 6),
        dailyLimit, ethers.parseUnits("100000", 6),
        ethers.parseUnits("500000", 6), periodEnd
      );
      const budgetReceipt = await budgetTx.wait();
      const budgetEvent = budgetReceipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = budgetEvent.args[0];

      // Create proposal below total allocation but above daily limit ($5K > $4K daily)
      const exceedingAmount = ethers.parseUnits("5000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, exceedingAmount, 0, "exceed daily", false, budgetId
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "DailyLimitExceeded");
    });

    it("should enforce budget total allocation at create time", async function () {
      const { treasury, usdc, admin, signer1, budgetMgr, recipient } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const budgetTx = await treasury.connect(budgetMgr).createBudget(
        "Small", 0, ethers.parseUnits("5000", 6), 0, 0, 0, periodEnd
      );
      const budgetReceipt = await budgetTx.wait();
      const budgetEvent = budgetReceipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = budgetEvent.args[0];

      // This should fail at createProposal time
      const exceedingAmount = ethers.parseUnits("6000", 6);
      await expect(treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, exceedingAmount, 0, "exceed budget", false, budgetId
      )).to.be.revertedWithCustomError(treasury, "BudgetExceeded");
    });

    it("should enforce weekly spending limit on execute", async function () {
      const { treasury, usdc, signer1, signer2, budgetMgr, recipient } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const weeklyLimit = ethers.parseUnits("4000", 6);
      const budgetTx = await treasury.connect(budgetMgr).createBudget(
        "WeeklyLimited", 0, ethers.parseUnits("1000000", 6),
        0, weeklyLimit, ethers.parseUnits("500000", 6), periodEnd
      );
      const budgetReceipt = await budgetTx.wait();
      const budgetEvent = budgetReceipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = budgetEvent.args[0];

      const exceedingAmount = ethers.parseUnits("5000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, exceedingAmount, 0, "exceed weekly", false, budgetId
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "WeeklyLimitExceeded");
    });

    it("should enforce monthly spending limit on execute", async function () {
      const { treasury, usdc, signer1, signer2, budgetMgr, recipient } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      const monthlyLimit = ethers.parseUnits("4000", 6);
      const budgetTx = await treasury.connect(budgetMgr).createBudget(
        "MonthlyLimited", 0, ethers.parseUnits("1000000", 6),
        0, 0, monthlyLimit, periodEnd
      );
      const budgetReceipt = await budgetTx.wait();
      const budgetEvent = budgetReceipt.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = budgetEvent.args[0];

      const exceedingAmount = ethers.parseUnits("5000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, exceedingAmount, 0, "exceed monthly", false, budgetId
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "MonthlyLimitExceeded");
    });
  });

  describe("Proposal Creation Edge Cases", function () {
    it("should revert with zero recipient", async function () {
      const { treasury, usdc, signer1 } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).createProposal(
        ethers.ZeroAddress, usdc.target, 1000, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("should revert with zero amount", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, 0, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("should revert with unsupported token", async function () {
      const { treasury, signer1, recipient, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).createProposal(
        recipient.address, other.address, 1000, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(treasury, "UnsupportedToken");
    });

    it("should revert with inactive budget", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      const fakeBudgetId = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, 1000, 0, "test", false, fakeBudgetId
      )).to.be.revertedWithCustomError(treasury, "BudgetNotFound");
    });
  });

  describe("Recurring Payment Edge Cases", function () {
    it("should revert with zero recipient", async function () {
      const { treasury, usdc, admin, signer1 } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).createRecurringPayment(
        ethers.ZeroAddress, usdc.target, 1000, 0, 0, "test", 0, ethers.ZeroHash
      )).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("should revert with zero amount", async function () {
      const { treasury, usdc, admin, signer1, recipient } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, 0, 0, 0, "test", 0, ethers.ZeroHash
      )).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });
  });

  describe("Large Tier Execution with 48h Timelock", function () {
    it("should execute large tier after 48h timelock", async function () {
      const { treasury, usdc, signer1, signer2, signer3, signer4, recipient } = await loadFixture(deployFixture);
      const largeAmount = ethers.parseUnits("200000", 6);
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, largeAmount, 0, "large", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const proposalId = event.args[0];

      await treasury.connect(signer2).approveProposal(proposalId);
      await treasury.connect(signer3).approveProposal(proposalId);
      await treasury.connect(signer4).approveProposal(proposalId);

      // 48h timelock for large tier
      await time.increase(48 * 3600 + 1);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.emit(treasury, "ProposalExecuted");
    });
  });

  describe("Delegation Edge Cases", function () {
    it("should revert delegation with zero address", async function () {
      const { treasury, signer1 } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).delegateSigningAuthority(ethers.ZeroAddress, 86400))
        .to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });

  describe("Receive Native Tokens", function () {
    it("should accept native tokens via receive()", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await admin.sendTransaction({ to: treasury.target, value: ethers.parseEther("1") });
      const balance = await ethers.provider.getBalance(treasury.target);
      expect(balance).to.equal(ethers.parseEther("1"));
    });
  });
});
