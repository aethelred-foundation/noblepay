import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("MultiSigTreasury", function () {
  async function deployFixture() {
    const [admin, signer1, signer2, signer3, signer4, signer5, budgetMgr, yieldMgr, recipient, delegate, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Treasury = await ethers.getContractFactory("MultiSigTreasury");
    const treasury = await Treasury.deploy(
      admin.address,
      [signer1.address, signer2.address, signer3.address, signer4.address, signer5.address],
      2, 3, 4, 4 // small:2, medium:3, large:4, emergency:4
    );

    // Grant roles
    await treasury.connect(admin).grantRole(await treasury.BUDGET_MANAGER_ROLE(), budgetMgr.address);
    await treasury.connect(admin).grantRole(await treasury.YIELD_MANAGER_ROLE(), yieldMgr.address);

    // Setup token
    await treasury.connect(admin).setSupportedToken(usdc.target, true);

    // Fund treasury
    await usdc.mint(treasury.target, ethers.parseUnits("10000000", 6));

    return { treasury, usdc, admin, signer1, signer2, signer3, signer4, signer5, budgetMgr, yieldMgr, recipient, delegate, other };
  }

  async function proposalCreatedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { treasury, usdc, signer1, recipient } = fixture;
    const amount = ethers.parseUnits("5000", 6); // small tier < $10k
    const tx = await treasury.connect(signer1).createProposal(
      recipient.address, usdc.target, amount, 0, "ops payment", false, ethers.ZeroHash
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
    const proposalId = event.args[0];
    return { ...fixture, proposalId, amount };
  }

  describe("Deployment", function () {
    it("should set signers and config", async function () {
      const { treasury, signer1 } = await loadFixture(deployFixture);
      const SIGNER_ROLE = await treasury.SIGNER_ROLE();
      expect(await treasury.hasRole(SIGNER_ROLE, signer1.address)).to.be.true;
      const config = await treasury.signerConfig();
      expect(config.totalSigners).to.equal(5);
      expect(config.smallThreshold).to.equal(2);
    });

    it("should revert with zero admin", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [, s1, s2] = await ethers.getSigners();
      await expect(Treasury.deploy(ethers.ZeroAddress, [s1.address, s2.address], 1, 1, 2, 2))
        .to.be.revertedWithCustomError(Treasury, "ZeroAddress");
    });

    it("should revert with fewer than 2 signers", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, s1] = await ethers.getSigners();
      await expect(Treasury.deploy(admin.address, [s1.address], 1, 1, 1, 1))
        .to.be.revertedWithCustomError(Treasury, "MinimumSignersRequired");
    });

    it("should revert with invalid config (threshold > signers)", async function () {
      const Treasury = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, s1, s2] = await ethers.getSigners();
      await expect(Treasury.deploy(admin.address, [s1.address, s2.address], 1, 2, 3, 3))
        .to.be.revertedWithCustomError(Treasury, "InvalidSignerConfig");
    });
  });

  describe("Proposal Lifecycle", function () {
    it("should create a proposal", async function () {
      const { treasury, usdc, signer1, recipient } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6), 0, "test", false, ethers.ZeroHash
      )).to.emit(treasury, "ProposalCreated");
    });

    it("should auto-approve by proposer", async function () {
      const { treasury, proposalId } = await proposalCreatedFixture();
      const prop = await treasury.proposals(proposalId);
      expect(prop.approvalCount).to.equal(1);
    });

    it("should approve by another signer", async function () {
      const { treasury, signer2, proposalId } = await proposalCreatedFixture();
      await expect(treasury.connect(signer2).approveProposal(proposalId))
        .to.emit(treasury, "ProposalApproved");
    });

    it("should mark as APPROVED when threshold met", async function () {
      const { treasury, signer2, proposalId } = await proposalCreatedFixture();
      await treasury.connect(signer2).approveProposal(proposalId);
      const prop = await treasury.proposals(proposalId);
      expect(prop.status).to.equal(1); // APPROVED
    });

    it("should execute after timelock", async function () {
      const { treasury, usdc, signer1, signer2, recipient, proposalId, amount } = await proposalCreatedFixture();
      await treasury.connect(signer2).approveProposal(proposalId);
      await time.increase(24 * 3600 + 1); // > 24h standard timelock
      const balBefore = await usdc.balanceOf(recipient.address);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.emit(treasury, "ProposalExecuted");
      expect(await usdc.balanceOf(recipient.address)).to.equal(balBefore + amount);
    });

    it("should revert execute before timelock", async function () {
      const { treasury, signer1, signer2, proposalId } = await proposalCreatedFixture();
      await treasury.connect(signer2).approveProposal(proposalId);
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "TimelockNotExpired");
    });

    it("should revert execute if not approved", async function () {
      const { treasury, signer1, proposalId } = await proposalCreatedFixture();
      await expect(treasury.connect(signer1).executeProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "InvalidProposalStatus");
    });

    it("should revert duplicate approval", async function () {
      const { treasury, signer1, proposalId } = await proposalCreatedFixture();
      await expect(treasury.connect(signer1).approveProposal(proposalId))
        .to.be.revertedWithCustomError(treasury, "AlreadyApproved");
    });

    it("should reject a proposal", async function () {
      const { treasury, signer2, proposalId } = await proposalCreatedFixture();
      await expect(treasury.connect(signer2).rejectProposal(proposalId))
        .to.emit(treasury, "ProposalRejected");
    });

    it("should cancel a proposal", async function () {
      const { treasury, signer1, proposalId } = await proposalCreatedFixture();
      await expect(treasury.connect(signer1).cancelProposal(proposalId))
        .to.emit(treasury, "ProposalCancelled");
    });

    it("should revert for non-signer", async function () {
      const { treasury, usdc, other, recipient } = await loadFixture(deployFixture);
      await expect(treasury.connect(other).createProposal(
        recipient.address, usdc.target, 1000, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(treasury, "NotSigner");
    });

    it("should classify large tx tier correctly", async function () {
      const { treasury, usdc, signer1, recipient } = await loadFixture(deployFixture);
      const largeAmount = ethers.parseUnits("200000", 6); // > $100k
      const tx = await treasury.connect(signer1).createProposal(
        recipient.address, usdc.target, largeAmount, 0, "large", false, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      expect(event.args.tier).to.equal(2); // LARGE
    });
  });

  describe("Budget Management", function () {
    it("should create a budget", async function () {
      const { treasury, budgetMgr } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      await expect(treasury.connect(budgetMgr).createBudget(
        "Engineering", 5, ethers.parseUnits("1000000", 6),
        ethers.parseUnits("10000", 6), ethers.parseUnits("50000", 6),
        ethers.parseUnits("200000", 6), periodEnd
      )).to.emit(treasury, "BudgetCreated");
    });

    it("should revert zero allocation", async function () {
      const { treasury, budgetMgr } = await loadFixture(deployFixture);
      const periodEnd = BigInt(await time.latest()) + 86400n * 365n;
      await expect(treasury.connect(budgetMgr).createBudget(
        "Empty", 0, 0, 0, 0, 0, periodEnd
      )).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });
  });

  describe("Recurring Payments", function () {
    it("should create a recurring payment", async function () {
      const { treasury, admin, signer1, recipient, usdc } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6),
        3, 1, "monthly salary", 12, ethers.ZeroHash
      )).to.emit(treasury, "RecurringPaymentCreated");
    });

    it("should execute a due recurring payment", async function () {
      const { treasury, admin, signer1, recipient, usdc, other } = await loadFixture(deployFixture);
      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6),
        3, 1, "monthly", 12, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      // Advance past next execution
      await time.increase(31 * 24 * 3600);
      await expect(treasury.connect(other).executeRecurringPayment(paymentId))
        .to.emit(treasury, "RecurringPaymentExecuted");
    });

    it("should revert if not yet due", async function () {
      const { treasury, admin, signer1, recipient, usdc, other } = await loadFixture(deployFixture);
      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6),
        3, 1, "monthly", 12, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      await expect(treasury.connect(other).executeRecurringPayment(paymentId))
        .to.be.revertedWithCustomError(treasury, "RecurringPaymentNotDue");
    });

    it("should revoke a recurring payment", async function () {
      const { treasury, admin, signer1, recipient, usdc } = await loadFixture(deployFixture);
      const tx = await treasury.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, 1000, 0, 0, "daily", 0, ethers.ZeroHash
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const paymentId = event.args[0];

      await expect(treasury.connect(signer1).revokeRecurringPayment(paymentId))
        .to.emit(treasury, "RecurringPaymentRevoked");
    });
  });

  describe("Delegation", function () {
    it("should delegate signing authority", async function () {
      const { treasury, signer1, delegate } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).delegateSigningAuthority(delegate.address, 86400 * 7))
        .to.emit(treasury, "DelegationCreated");
    });

    it("should revert delegation too long", async function () {
      const { treasury, signer1, delegate } = await loadFixture(deployFixture);
      await expect(treasury.connect(signer1).delegateSigningAuthority(delegate.address, 86400 * 31))
        .to.be.revertedWithCustomError(treasury, "DelegationTooLong");
    });

    it("should revoke delegation", async function () {
      const { treasury, signer1, delegate } = await loadFixture(deployFixture);
      await treasury.connect(signer1).delegateSigningAuthority(delegate.address, 86400 * 7);
      await expect(treasury.connect(signer1).revokeDelegation(delegate.address))
        .to.emit(treasury, "DelegationRevoked");
    });

    it("delegate should be able to create proposal", async function () {
      const { treasury, usdc, signer1, delegate, recipient } = await loadFixture(deployFixture);
      await treasury.connect(signer1).delegateSigningAuthority(delegate.address, 86400 * 7);
      await expect(treasury.connect(delegate).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6), 0, "test", false, ethers.ZeroHash
      )).to.emit(treasury, "ProposalCreated");
    });
  });

  describe("Yield Management", function () {
    it("should approve yield protocol", async function () {
      const { treasury, admin, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).approveYieldProtocol(
        other.address, "Aave", ethers.parseUnits("1000000", 6)
      )).to.emit(treasury, "YieldProtocolApproved");
    });
  });

  describe("Admin", function () {
    it("should set supported token", async function () {
      const { treasury, admin, other } = await loadFixture(deployFixture);
      await expect(treasury.connect(admin).setSupportedToken(other.address, true))
        .to.emit(treasury, "TokenSupported");
    });

    it("should pause and unpause", async function () {
      const { treasury, admin } = await loadFixture(deployFixture);
      await treasury.connect(admin).pause();
      expect(await treasury.paused()).to.be.true;
      await treasury.connect(admin).unpause();
    });
  });
});
