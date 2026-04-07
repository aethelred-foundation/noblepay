import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

/**
 * BranchMax3 — targets uncovered branches in:
 *   MultiSigTreasury, NoblePay, plus deeper edges in other contracts
 */
describe("BranchMax3", function () {

  // ═══════════════════════════════════════════════════════════════
  // MultiSigTreasury
  // ═══════════════════════════════════════════════════════════════
  describe("MultiSigTreasury — deep branch coverage", function () {
    async function deployMST() {
      const [admin, s1, s2, s3, s4, s5, budgetMgr, yieldMgr, recipient, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const mst = await MST.deploy(
        admin.address,
        [s1.address, s2.address, s3.address, s4.address, s5.address],
        2, 3, 4, 4 // small=2, medium=3, large=4, emergency=4
      );
      await mst.connect(admin).grantRole(await mst.BUDGET_MANAGER_ROLE(), budgetMgr.address);
      await mst.connect(admin).grantRole(await mst.YIELD_MANAGER_ROLE(), yieldMgr.address);
      await mst.connect(admin).setSupportedToken(usdc.target, true);
      // Fund treasury
      const amt = ethers.parseUnits("10000000", 6);
      await usdc.mint(mst.target, amt);
      return { mst, usdc, admin, s1, s2, s3, s4, s5, budgetMgr, yieldMgr, recipient, other };
    }

    it("reverts constructor with zero admin", async function () {
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const [, a, b] = await ethers.getSigners();
      await expect(MST.deploy(ethers.ZeroAddress, [a.address, b.address], 1, 1, 2, 2))
        .to.be.revertedWithCustomError(MST, "ZeroAddress");
    });

    it("reverts constructor with <2 signers", async function () {
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, a] = await ethers.getSigners();
      await expect(MST.deploy(admin.address, [a.address], 1, 1, 1, 1))
        .to.be.revertedWithCustomError(MST, "MinimumSignersRequired");
    });

    it("reverts constructor with invalid thresholds (small=0)", async function () {
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, a, b] = await ethers.getSigners();
      await expect(MST.deploy(admin.address, [a.address, b.address], 0, 1, 2, 2))
        .to.be.revertedWithCustomError(MST, "InvalidSignerConfig");
    });

    it("reverts constructor with invalid thresholds (small > medium)", async function () {
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, a, b, c] = await ethers.getSigners();
      await expect(MST.deploy(admin.address, [a.address, b.address, c.address], 3, 2, 3, 3))
        .to.be.revertedWithCustomError(MST, "InvalidSignerConfig");
    });

    it("reverts constructor with invalid thresholds (large > signers)", async function () {
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, a, b] = await ethers.getSigners();
      await expect(MST.deploy(admin.address, [a.address, b.address], 1, 2, 3, 3))
        .to.be.revertedWithCustomError(MST, "InvalidSignerConfig");
    });

    it("reverts constructor with zero signer address", async function () {
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const [admin, a] = await ethers.getSigners();
      await expect(MST.deploy(admin.address, [a.address, ethers.ZeroAddress], 1, 1, 2, 2))
        .to.be.revertedWithCustomError(MST, "ZeroAddress");
    });

    it("creates SMALL proposal (amount <= 10K)", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      await expect(mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "small", false, ethers.ZeroHash
      )).to.emit(mst, "ProposalCreated");
    });

    it("creates MEDIUM proposal (10K < amount <= 100K)", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("50000", 6);
      await expect(mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "medium", false, ethers.ZeroHash
      )).to.emit(mst, "ProposalCreated");
    });

    it("creates LARGE proposal (amount > 100K)", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("200000", 6);
      await expect(mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "large", false, ethers.ZeroHash
      )).to.emit(mst, "ProposalCreated");
    });

    it("creates EMERGENCY proposal", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      await expect(mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "emergency", true, ethers.ZeroHash
      )).to.emit(mst, "ProposalCreated");
    });

    it("reverts proposal with zero recipient", async function () {
      const { mst, usdc, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).createProposal(
        ethers.ZeroAddress, usdc.target, 1000, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("reverts proposal with zero amount", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      await expect(mst.connect(s1).createProposal(
        recipient.address, usdc.target, 0, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(mst, "ZeroAmount");
    });

    it("reverts proposal with unsupported token", async function () {
      const { mst, s1, recipient, other } = await loadFixture(deployMST);
      await expect(mst.connect(s1).createProposal(
        recipient.address, other.address, 1000, 0, "test", false, ethers.ZeroHash
      )).to.be.revertedWithCustomError(mst, "UnsupportedToken");
    });

    it("proposal with native token (address(0)) allowed", async function () {
      const { mst, s1, recipient } = await loadFixture(deployMST);
      await expect(mst.connect(s1).createProposal(
        recipient.address, ethers.ZeroAddress, 1000, 0, "native", false, ethers.ZeroHash
      )).to.emit(mst, "ProposalCreated");
    });

    it("approve, reach threshold, execute ERC20 proposal after timelock", async function () {
      const { mst, usdc, s1, s2, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6); // SMALL, needs 2 approvals
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated");
      const pid = ev.args[0];
      // s1 auto-approved, s2 approves -> threshold reached
      await mst.connect(s2).approveProposal(pid);
      // Wait for timelock (24h)
      await time.increase(25 * 3600);
      await mst.connect(s1).executeProposal(pid);
    });

    it("execute native proposal", async function () {
      const { mst, s1, s2, recipient } = await loadFixture(deployMST);
      // Fund contract with native
      await s1.sendTransaction({ to: mst.target, value: ethers.parseEther("1") });
      const amt = 1000n;
      const tx = await mst.connect(s1).createProposal(
        recipient.address, ethers.ZeroAddress, amt, 0, "native pay", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).approveProposal(pid);
      await time.increase(25 * 3600);
      await mst.connect(s1).executeProposal(pid);
    });

    it("reverts execute before timelock", async function () {
      const { mst, usdc, s1, s2, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).approveProposal(pid);
      await expect(mst.connect(s1).executeProposal(pid))
        .to.be.revertedWithCustomError(mst, "TimelockNotExpired");
    });

    it("reverts execute on non-approved proposal", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await expect(mst.connect(s1).executeProposal(pid))
        .to.be.revertedWithCustomError(mst, "InvalidProposalStatus");
    });

    it("reverts double approval", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await expect(mst.connect(s1).approveProposal(pid))
        .to.be.revertedWithCustomError(mst, "AlreadyApproved");
    });

    it("reject proposal until auto-rejected", async function () {
      const { mst, usdc, s1, s2, s3, s4, s5, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6); // SMALL, needs 2, so reject threshold = 5-2+1=4
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).rejectProposal(pid);
      await mst.connect(s3).rejectProposal(pid);
      await mst.connect(s4).rejectProposal(pid);
      await mst.connect(s5).rejectProposal(pid);
      const p = await mst.getProposal(pid);
      expect(p.status).to.equal(3); // REJECTED
    });

    it("reverts double rejection", async function () {
      const { mst, usdc, s1, s2, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).rejectProposal(pid);
      await expect(mst.connect(s2).rejectProposal(pid))
        .to.be.revertedWithCustomError(mst, "AlreadyRejected");
    });

    it("cancel proposal by proposer", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s1).cancelProposal(pid);
    });

    it("cancel proposal by admin", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(admin).cancelProposal(pid);
    });

    it("reverts cancel by non-proposer non-admin", async function () {
      const { mst, usdc, s1, s2, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await expect(mst.connect(s2).cancelProposal(pid)).to.be.revert(ethers);
    });

    it("reverts execute after expiry", async function () {
      const { mst, usdc, s1, s2, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).approveProposal(pid);
      await time.increase(8 * 86400); // past 7-day expiry
      await expect(mst.connect(s1).executeProposal(pid))
        .to.be.revertedWithCustomError(mst, "ProposalExpiredError");
    });

    it("reverts approve after expiry", async function () {
      const { mst, usdc, s1, s2, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await time.increase(8 * 86400);
      await expect(mst.connect(s2).approveProposal(pid))
        .to.be.revertedWithCustomError(mst, "ProposalExpiredError");
    });

    it("createBudget and proposal with budget", async function () {
      const { mst, usdc, admin, budgetMgr, s1, recipient } = await loadFixture(deployMST);
      const periodEnd = BigInt(await time.latest()) + 90n * 86400n;
      const tx = await mst.connect(budgetMgr).createBudget(
        "Ops", 0, ethers.parseUnits("1000000", 6),
        ethers.parseUnits("50000", 6), ethers.parseUnits("200000", 6),
        ethers.parseUnits("500000", 6), periodEnd
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated");
      const budgetId = ev.args[0];
      // Create proposal tied to budget
      await mst.connect(s1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("5000", 6),
        0, "budgeted", false, budgetId
      );
    });

    it("reverts budget with zero allocation", async function () {
      const { mst, budgetMgr } = await loadFixture(deployMST);
      const periodEnd = BigInt(await time.latest()) + 90n * 86400n;
      await expect(mst.connect(budgetMgr).createBudget(
        "Ops", 0, 0, 1000, 5000, 10000, periodEnd
      )).to.be.revertedWithCustomError(mst, "ZeroAmount");
    });

    it("reverts budget with past period", async function () {
      const { mst, budgetMgr } = await loadFixture(deployMST);
      await expect(mst.connect(budgetMgr).createBudget(
        "Ops", 0, 1000000, 1000, 5000, 10000, 1
      )).to.be.revert(ethers);
    });

    it("reverts proposal with budget exceeded", async function () {
      const { mst, usdc, admin, budgetMgr, s1, recipient } = await loadFixture(deployMST);
      const periodEnd = BigInt(await time.latest()) + 90n * 86400n;
      const tx = await mst.connect(budgetMgr).createBudget(
        "Ops", 0, ethers.parseUnits("1000", 6), 0, 0, 0, periodEnd
      );
      const r = await tx.wait();
      const budgetId = r.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated").args[0];
      await expect(mst.connect(s1).createProposal(
        recipient.address, usdc.target, ethers.parseUnits("2000", 6),
        0, "over budget", false, budgetId
      )).to.be.revertedWithCustomError(mst, "BudgetExceeded");
    });

    it("create and execute recurring payment (ERC20)", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const amt = ethers.parseUnits("1000", 6);
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, amt, 0, 0, "salary", 3, ethers.ZeroHash
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated");
      const rpId = ev.args[0];
      // Advance past frequency (DAILY = 1 day)
      await time.increase(2 * 86400);
      await mst.connect(s1).executeRecurringPayment(rpId);
    });

    it("reverts recurring payment not due", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, 1000, 0, 0, "test", 5, ethers.ZeroHash
      );
      const r = await tx.wait();
      const rpId = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated").args[0];
      await expect(mst.connect(s1).executeRecurringPayment(rpId))
        .to.be.revertedWithCustomError(mst, "RecurringPaymentNotDue");
    });

    it("reverts recurring payment max executions", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, 1000, 0, 0, "test", 1, ethers.ZeroHash
      );
      const r = await tx.wait();
      const rpId = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated").args[0];
      await time.increase(2 * 86400);
      await mst.connect(s1).executeRecurringPayment(rpId);
      await time.increase(2 * 86400);
      await expect(mst.connect(s1).executeRecurringPayment(rpId))
        .to.be.revertedWithCustomError(mst, "MaxExecutionsReached");
    });

    it("revoke recurring payment", async function () {
      const { mst, usdc, admin, s1, recipient } = await loadFixture(deployMST);
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, 1000, 0, 0, "test", 0, ethers.ZeroHash
      );
      const r = await tx.wait();
      const rpId = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated").args[0];
      await mst.connect(s1).revokeRecurringPayment(rpId);
    });

    it("reverts recurring payment with zero recipient", async function () {
      const { mst, usdc, admin, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(admin).createRecurringPayment(
        ethers.ZeroAddress, usdc.target, 1000, 0, 0, "test", 0, ethers.ZeroHash
      )).to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("delegate signing authority and use it", async function () {
      const { mst, usdc, s1, other, recipient } = await loadFixture(deployMST);
      await mst.connect(s1).delegateSigningAuthority(other.address, 7 * 86400);
      // Delegate creates proposal
      const amt = ethers.parseUnits("5000", 6);
      await expect(mst.connect(other).createProposal(
        recipient.address, usdc.target, amt, 0, "delegated", false, ethers.ZeroHash
      )).to.emit(mst, "ProposalCreated");
    });

    it("reverts delegation with zero delegate", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).delegateSigningAuthority(ethers.ZeroAddress, 86400))
        .to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("reverts delegation too long", async function () {
      const { mst, s1, other } = await loadFixture(deployMST);
      await expect(mst.connect(s1).delegateSigningAuthority(other.address, 31 * 86400))
        .to.be.revertedWithCustomError(mst, "DelegationTooLong");
    });

    it("revoke delegation", async function () {
      const { mst, s1, other } = await loadFixture(deployMST);
      await mst.connect(s1).delegateSigningAuthority(other.address, 7 * 86400);
      await mst.connect(s1).revokeDelegation(other.address);
    });

    it("addSigner and removeSigner (swap-and-pop)", async function () {
      const { mst, admin, other } = await loadFixture(deployMST);
      await mst.connect(admin).addSigner(other.address);
      expect((await mst.getSignerConfig()).totalSigners).to.equal(6);
      await mst.connect(admin).removeSigner(other.address);
      expect((await mst.getSignerConfig()).totalSigners).to.equal(5);
    });

    it("reverts addSigner duplicate", async function () {
      const { mst, admin, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(admin).addSigner(s1.address))
        .to.be.revertedWithCustomError(mst, "SignerAlreadyExists");
    });

    it("reverts removeSigner below threshold", async function () {
      const { mst, admin, s1, s5, other } = await loadFixture(deployMST);
      // Add and remove to get to exactly threshold count
      await mst.connect(admin).addSigner(other.address); // now 6
      await mst.connect(admin).removeSigner(other.address); // back to 5
      await mst.connect(admin).removeSigner(s5.address); // 4 = largeThreshold
      // Now totalSigners == largeThreshold, can't remove more
      await expect(mst.connect(admin).removeSigner(s1.address))
        .to.be.revertedWithCustomError(mst, "MinimumSignersRequired");
    });

    it("removeSigner non-last triggers swap-and-pop", async function () {
      const { mst, admin, s1, other } = await loadFixture(deployMST);
      // Add extra signer first so we can remove
      await mst.connect(admin).addSigner(other.address);
      // Now remove s1 (not last) -> swap-and-pop
      await mst.connect(admin).removeSigner(s1.address);
    });

    it("updateSignerConfig", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await mst.connect(admin).updateSignerConfig(1, 2, 3, 3);
    });

    it("reverts updateSignerConfig invalid", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await expect(mst.connect(admin).updateSignerConfig(0, 2, 3, 3))
        .to.be.revertedWithCustomError(mst, "InvalidSignerConfig");
    });

    it("approveYieldProtocol and allocateToYield", async function () {
      const { mst, usdc, admin, yieldMgr, other } = await loadFixture(deployMST);
      await mst.connect(admin).approveYieldProtocol(other.address, "Aave", ethers.parseUnits("1000000", 6));
      await mst.connect(yieldMgr).allocateToYield(other.address, usdc.target, ethers.parseUnits("100", 6));
    });

    it("reverts allocateToYield unapproved protocol", async function () {
      const { mst, usdc, yieldMgr, other } = await loadFixture(deployMST);
      await expect(mst.connect(yieldMgr).allocateToYield(other.address, usdc.target, 1000))
        .to.be.revertedWithCustomError(mst, "ProtocolNotApproved");
    });

    it("reverts allocateToYield exceeds max", async function () {
      const { mst, usdc, admin, yieldMgr, other } = await loadFixture(deployMST);
      await mst.connect(admin).approveYieldProtocol(other.address, "Aave", 100);
      await expect(mst.connect(yieldMgr).allocateToYield(other.address, usdc.target, 200))
        .to.be.revertedWithCustomError(mst, "AllocationExceeded");
    });

    it("reverts allocateToYield zero amount", async function () {
      const { mst, usdc, admin, yieldMgr, other } = await loadFixture(deployMST);
      await mst.connect(admin).approveYieldProtocol(other.address, "Aave", 10000);
      await expect(mst.connect(yieldMgr).allocateToYield(other.address, usdc.target, 0))
        .to.be.revertedWithCustomError(mst, "ZeroAmount");
    });

    it("setNoblePayContract", async function () {
      const { mst, admin, other } = await loadFixture(deployMST);
      await mst.connect(admin).setNoblePayContract(other.address);
    });

    it("reverts setNoblePayContract zero", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await expect(mst.connect(admin).setNoblePayContract(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("setSupportedToken zero reverts", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await expect(mst.connect(admin).setSupportedToken(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("pause and unpause", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await mst.connect(admin).pause();
      expect(await mst.paused()).to.be.true;
      await mst.connect(admin).unpause();
    });

    it("execute proposal with budget spending and daily/weekly/monthly tracking", async function () {
      const { mst, usdc, budgetMgr, s1, s2, recipient } = await loadFixture(deployMST);
      const periodEnd = BigInt(await time.latest()) + 90n * 86400n;
      const btx = await mst.connect(budgetMgr).createBudget(
        "Ops", 0, ethers.parseUnits("1000000", 6),
        ethers.parseUnits("100000", 6), ethers.parseUnits("500000", 6),
        ethers.parseUnits("900000", 6), periodEnd
      );
      const br = await btx.wait();
      const budgetId = br.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated").args[0];

      const amt = ethers.parseUnits("5000", 6);
      const tx = await mst.connect(s1).createProposal(
        recipient.address, usdc.target, amt, 0, "budgeted", false, budgetId
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).approveProposal(pid);
      await time.increase(25 * 3600);
      await mst.connect(s1).executeProposal(pid);
    });

    it("recurring payment with native token", async function () {
      const { mst, admin, s1, recipient } = await loadFixture(deployMST);
      // Fund contract
      await s1.sendTransaction({ to: mst.target, value: ethers.parseEther("1") });
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, ethers.ZeroAddress, 1000, 0, 0, "native", 2, ethers.ZeroHash
      );
      const r = await tx.wait();
      const rpId = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated").args[0];
      await time.increase(2 * 86400);
      await mst.connect(s1).executeRecurringPayment(rpId);
    });

    it("recurring payment with budget tracking", async function () {
      const { mst, usdc, admin, budgetMgr, s1, recipient } = await loadFixture(deployMST);
      const periodEnd = BigInt(await time.latest()) + 90n * 86400n;
      const btx = await mst.connect(budgetMgr).createBudget(
        "Payroll", 1, ethers.parseUnits("100000", 6), 0, 0, 0, periodEnd
      );
      const br = await btx.wait();
      const budgetId = br.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated").args[0];
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("1000", 6), 0, 1, "payroll", 0, budgetId
      );
      const r = await tx.wait();
      const rpId = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated").args[0];
      await time.increase(2 * 86400);
      await mst.connect(s1).executeRecurringPayment(rpId);
    });

    it("view functions return data", async function () {
      const { mst } = await loadFixture(deployMST);
      const signers = await mst.getSigners();
      expect(signers.length).to.equal(5);
      const config = await mst.getSignerConfig();
      expect(config.smallThreshold).to.equal(2);
      const budgets = await mst.getActiveBudgets();
      expect(budgets.length).to.equal(0);
    });

    it("execute recurring payment that crosses day/week/month boundary", async function () {
      const { mst, usdc, admin, budgetMgr, s1, recipient } = await loadFixture(deployMST);
      const periodEnd = BigInt(await time.latest()) + 365n * 86400n;
      const btx = await mst.connect(budgetMgr).createBudget(
        "Test", 0, ethers.parseUnits("10000000", 6),
        ethers.parseUnits("100000", 6), ethers.parseUnits("500000", 6),
        ethers.parseUnits("2000000", 6), periodEnd
      );
      const br = await btx.wait();
      const budgetId = br.logs.find(l => l.fragment && l.fragment.name === "BudgetCreated").args[0];
      const tx = await mst.connect(admin).createRecurringPayment(
        recipient.address, usdc.target, ethers.parseUnits("100", 6),
        4, 0, "quarterly", 4, budgetId // QUARTERLY
      );
      const r = await tx.wait();
      const rpId = r.logs.find(l => l.fragment && l.fragment.name === "RecurringPaymentCreated").args[0];
      // Advance 91 days to cross day/week/month boundaries + pass quarterly period
      await time.increase(91 * 86400);
      await mst.connect(s1).executeRecurringPayment(rpId);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // NoblePay
  // ═══════════════════════════════════════════════════════════════
  describe("NoblePay — deep branch coverage", function () {
    async function deployNP() {
      const [admin, treasury, teeNode, officer, sender, recipient, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      const NP = await ethers.getContractFactory("NoblePay");
      const np = await NP.deploy(admin.address, treasury.address, ethers.parseUnits("1", 6), 50);
      await np.connect(admin).grantRole(await np.TEE_NODE_ROLE(), teeNode.address);
      await np.connect(admin).grantRole(await np.COMPLIANCE_OFFICER_ROLE(), officer.address);
      await np.connect(admin).setSupportedToken(usdc.target, true);
      // Register sender as business
      await np.connect(admin).syncBusiness(sender.address, 0, true); // STANDARD
      // Mint and approve
      const amt = ethers.parseUnits("10000000", 6);
      await usdc.mint(sender.address, amt);
      await usdc.connect(sender).approve(np.target, ethers.MaxUint256);
      return { np, usdc, admin, treasury, teeNode, officer, sender, recipient, other };
    }

    const PURPOSE = ethers.keccak256(ethers.toUtf8Bytes("payment"));

    async function initPayment(np, sender, recipient, usdc, amount) {
      const amt = amount || ethers.parseUnits("1000", 6);
      const tx = await np.connect(sender).initiatePayment(
        recipient.address, amt, usdc.target, PURPOSE, "0x414544"
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      return ev.args[0];
    }

    it("reverts constructor with zero admin", async function () {
      const NP = await ethers.getContractFactory("NoblePay");
      const [, t] = await ethers.getSigners();
      await expect(NP.deploy(ethers.ZeroAddress, t.address, 100, 50))
        .to.be.revertedWithCustomError(NP, "ZeroAddress");
    });

    it("reverts constructor with zero treasury", async function () {
      const NP = await ethers.getContractFactory("NoblePay");
      const [a] = await ethers.getSigners();
      await expect(NP.deploy(a.address, ethers.ZeroAddress, 100, 50))
        .to.be.revertedWithCustomError(NP, "ZeroAddress");
    });

    it("reverts constructor with excessive fee", async function () {
      const NP = await ethers.getContractFactory("NoblePay");
      const [a, t] = await ethers.getSigners();
      await expect(NP.deploy(a.address, t.address, 100, 501))
        .to.be.revertedWithCustomError(NP, "InvalidFee");
    });

    it("initiatePayment with ERC20", async function () {
      const { np, usdc, sender, recipient } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        recipient.address, ethers.parseUnits("100", 6), usdc.target, PURPOSE, "0x414544"
      )).to.emit(np, "PaymentInitiated");
    });

    it("initiatePayment with native token", async function () {
      const { np, sender, recipient } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        recipient.address, 1000, ethers.ZeroAddress, PURPOSE, "0x414544",
        { value: 1000 }
      )).to.emit(np, "PaymentInitiated");
    });

    it("reverts native payment with insufficient value", async function () {
      const { np, sender, recipient } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        recipient.address, 1000, ethers.ZeroAddress, PURPOSE, "0x414544",
        { value: 500 }
      )).to.be.revertedWithCustomError(np, "InsufficientPayment");
    });

    it("reverts payment with zero recipient", async function () {
      const { np, usdc, sender } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        ethers.ZeroAddress, 1000, usdc.target, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "ZeroAddress");
    });

    it("reverts payment with self recipient", async function () {
      const { np, usdc, sender } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        sender.address, 1000, usdc.target, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "InvalidRecipient");
    });

    it("reverts payment with zero amount", async function () {
      const { np, usdc, sender, recipient } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        recipient.address, 0, usdc.target, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "ZeroAmount");
    });

    it("reverts payment with unsupported token", async function () {
      const { np, sender, recipient, other } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePayment(
        recipient.address, 1000, other.address, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "UnsupportedToken");
    });

    it("reverts payment from unregistered business", async function () {
      const { np, usdc, other, recipient } = await loadFixture(deployNP);
      await expect(np.connect(other).initiatePayment(
        recipient.address, 1000, usdc.target, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "NotRegisteredBusiness");
    });

    it("compliance: BLOCKED (sanctions fail)", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await expect(np.connect(teeNode).submitComplianceResult(
        pid, false, 50, true, ethers.ZeroHash, "0x"
      )).to.emit(np, "PaymentBlocked");
    });

    it("compliance: FLAGGED (high risk score)", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await expect(np.connect(teeNode).submitComplianceResult(
        pid, true, 80, true, ethers.ZeroHash, "0x"
      )).to.emit(np, "PaymentFlagged");
    });

    it("compliance: FLAGGED (travel rule fail)", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await expect(np.connect(teeNode).submitComplianceResult(
        pid, true, 30, false, ethers.ZeroHash, "0x"
      )).to.emit(np, "PaymentFlagged");
    });

    it("compliance: PASSED then settle ERC20", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await np.connect(teeNode).submitComplianceResult(pid, true, 30, true, ethers.ZeroHash, "0x");
      await np.connect(sender).settlePayment(pid);
    });

    it("settle with zero fee", async function () {
      const { np, usdc, admin, sender, recipient, teeNode } = await loadFixture(deployNP);
      await np.connect(admin).setFees(0, 0);
      const pid = await initPayment(np, sender, recipient, usdc);
      await np.connect(teeNode).submitComplianceResult(pid, true, 30, true, ethers.ZeroHash, "0x");
      await np.connect(sender).settlePayment(pid);
    });

    it("refund BLOCKED payment", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await np.connect(teeNode).submitComplianceResult(pid, false, 50, true, ethers.ZeroHash, "0x");
      await np.connect(sender).refundPayment(pid);
    });

    it("refund FLAGGED payment by compliance officer", async function () {
      const { np, usdc, sender, recipient, teeNode, officer } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await np.connect(teeNode).submitComplianceResult(pid, true, 80, true, ethers.ZeroHash, "0x");
      await np.connect(officer).refundPayment(pid);
    });

    it("cancel PENDING payment", async function () {
      const { np, usdc, sender, recipient } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await np.connect(sender).cancelPayment(pid);
    });

    it("reverts cancel by non-sender", async function () {
      const { np, usdc, sender, recipient, other } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await expect(np.connect(other).cancelPayment(pid)).to.be.revert(ethers);
    });

    it("reverts settle on non-PASSED payment", async function () {
      const { np, usdc, sender, recipient } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await expect(np.connect(sender).settlePayment(pid))
        .to.be.revertedWithCustomError(np, "InvalidPaymentStatus");
    });

    it("reverts compliance result with score > 100", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await expect(np.connect(teeNode).submitComplianceResult(
        pid, true, 101, true, ethers.ZeroHash, "0x"
      )).to.be.revertedWithCustomError(np, "InvalidRiskScore");
    });

    it("reverts compliance on non-PENDING payment", async function () {
      const { np, usdc, sender, recipient, teeNode } = await loadFixture(deployNP);
      const pid = await initPayment(np, sender, recipient, usdc);
      await np.connect(teeNode).submitComplianceResult(pid, true, 30, true, ethers.ZeroHash, "0x");
      await expect(np.connect(teeNode).submitComplianceResult(
        pid, true, 30, true, ethers.ZeroHash, "0x"
      )).to.be.revertedWithCustomError(np, "InvalidPaymentStatus");
    });

    it("batch payment", async function () {
      const { np, usdc, sender, recipient, other } = await loadFixture(deployNP);
      await np.connect(sender).initiatePaymentBatch(
        [recipient.address, other.address],
        [ethers.parseUnits("100", 6), ethers.parseUnits("200", 6)],
        [usdc.target, usdc.target],
        [PURPOSE, PURPOSE],
        ["0x414544", "0x555344"]
      );
    });

    it("reverts batch empty", async function () {
      const { np, sender } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePaymentBatch([], [], [], [], []))
        .to.be.revertedWithCustomError(np, "BatchEmpty");
    });

    it("reverts batch length mismatch", async function () {
      const { np, usdc, sender, recipient } = await loadFixture(deployNP);
      await expect(np.connect(sender).initiatePaymentBatch(
        [recipient.address], [1000, 2000], [usdc.target], [PURPOSE], ["0x414544"]
      )).to.be.revert(ethers);
    });

    it("setFees", async function () {
      const { np, admin } = await loadFixture(deployNP);
      await np.connect(admin).setFees(ethers.parseUnits("5", 6), 100);
    });

    it("reverts setFees excessive", async function () {
      const { np, admin } = await loadFixture(deployNP);
      await expect(np.connect(admin).setFees(0, 501))
        .to.be.revertedWithCustomError(np, "InvalidFee");
    });

    it("setTreasury", async function () {
      const { np, admin, other } = await loadFixture(deployNP);
      await np.connect(admin).setTreasury(other.address);
    });

    it("reverts setTreasury zero", async function () {
      const { np, admin } = await loadFixture(deployNP);
      await expect(np.connect(admin).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(np, "ZeroAddress");
    });

    it("setSupportedToken zero reverts", async function () {
      const { np, admin } = await loadFixture(deployNP);
      await expect(np.connect(admin).setSupportedToken(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(np, "ZeroAddress");
    });

    it("getDailyLimit and getMonthlyLimit for all tiers", async function () {
      const { np } = await loadFixture(deployNP);
      expect(await np.getDailyLimit(0)).to.equal(50000n * 1000000n); // STANDARD
      expect(await np.getDailyLimit(1)).to.equal(500000n * 1000000n); // PREMIUM
      expect(await np.getDailyLimit(2)).to.equal(5000000n * 1000000n); // ENTERPRISE
      expect(await np.getMonthlyLimit(0)).to.equal(500000n * 1000000n);
      expect(await np.getMonthlyLimit(1)).to.equal(5000000n * 1000000n);
      expect(await np.getMonthlyLimit(2)).to.equal(50000000n * 1000000n);
    });

    it("daily limit exceeded reverts", async function () {
      const { np, usdc, sender, recipient } = await loadFixture(deployNP);
      // STANDARD daily limit = 50K. Try 51K
      await expect(np.connect(sender).initiatePayment(
        recipient.address, ethers.parseUnits("51000", 6), usdc.target, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "DailyLimitExceeded");
    });

    it("PREMIUM tier has higher daily limit", async function () {
      const { np, usdc, admin, sender, recipient } = await loadFixture(deployNP);
      await np.connect(admin).syncBusiness(sender.address, 1, true); // PREMIUM
      await np.connect(sender).initiatePayment(
        recipient.address, ethers.parseUnits("51000", 6), usdc.target, PURPOSE, "0x414544"
      );
    });

    it("ENTERPRISE tier has highest daily limit", async function () {
      const { np, usdc, admin, sender, recipient } = await loadFixture(deployNP);
      await np.connect(admin).syncBusiness(sender.address, 2, true); // ENTERPRISE
      await np.connect(sender).initiatePayment(
        recipient.address, ethers.parseUnits("501000", 6), usdc.target, PURPOSE, "0x414544"
      );
    });

    it("pause and unpause", async function () {
      const { np, admin } = await loadFixture(deployNP);
      await np.connect(admin).pause();
      expect(await np.paused()).to.be.true;
      await np.connect(admin).unpause();
    });

    it("syncBusiness", async function () {
      const { np, admin, other } = await loadFixture(deployNP);
      await np.connect(admin).syncBusiness(other.address, 2, true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Additional edge cases for other contracts
  // ═══════════════════════════════════════════════════════════════
  describe("StreamingPayments — extra edges", function () {
    async function deploySP() {
      const [admin, sender, recipient, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      const SP = await ethers.getContractFactory("StreamingPayments");
      const sp = await SP.deploy(admin.address);
      const amt = ethers.parseUnits("10000000", 6);
      await token.mint(sender.address, amt);
      await token.connect(sender).approve(sp.target, ethers.MaxUint256);
      return { sp, token, admin, sender, recipient, other };
    }

    it("createStream with zero token reverts", async function () {
      const { sp, sender, recipient } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createStream(
        recipient.address, ethers.ZeroAddress, ethers.parseUnits("1000", 6), 3600, 0
      )).to.be.revert(ethers);
    });

    it("createStream with cliff > MAX_CLIFF_PERIOD reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createStream(
        recipient.address, token.target, ethers.parseUnits("1000", 6), 400 * 86400, 366 * 86400
      )).to.be.revert(ethers);
    });

    it("createBatchStreams", async function () {
      const { sp, token, sender, recipient, other } = await loadFixture(deploySP);
      const amt = ethers.parseUnits("1000", 6);
      await sp.connect(sender).createBatchStreams(
        [recipient.address, other.address], token.target, [amt, amt], 3600, 0
      );
    });

    it("createBatchStreams empty reverts", async function () {
      const { sp, token, sender } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createBatchStreams(
        [], token.target, [], 3600, 0
      )).to.be.revert(ethers);
    });

    it("createBatchStreams length mismatch reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createBatchStreams(
        [recipient.address], token.target, [1000, 2000], 3600, 0
      )).to.be.revert(ethers);
    });

    it("createBatchStreams too many reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const recipients = Array(51).fill(recipient.address);
      const amounts = Array(51).fill(1000);
      await expect(sp.connect(sender).createBatchStreams(
        recipients, token.target, amounts, 3600, 0
      )).to.be.revert(ethers);
    });

    it("pauseStream already paused reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const amt = ethers.parseUnits("1000", 6);
      const tx = await sp.connect(sender).createStream(recipient.address, token.target, amt, 3600, 0);
      const r = await tx.wait();
      const sid = r.logs.find(l => l.fragment && l.fragment.name === "StreamCreated").args[0];
      await sp.connect(sender).pauseStream(sid);
      await expect(sp.connect(sender).pauseStream(sid)).to.be.revert(ethers);
    });

    it("withdraw nothing available reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const amt = ethers.parseUnits("1000", 6);
      const tx = await sp.connect(sender).createStream(recipient.address, token.target, amt, 3600, 0);
      const r = await tx.wait();
      const sid = r.logs.find(l => l.fragment && l.fragment.name === "StreamCreated").args[0];
      // Withdraw immediately after creation - might have ~0 available
      // Actually some time has passed so let's try on paused stream
      await sp.connect(sender).pauseStream(sid);
      await expect(sp.connect(recipient).withdraw(sid)).to.be.revert(ethers);
    });

    it("pause and unpause contract", async function () {
      const { sp, admin } = await loadFixture(deploySP);
      await sp.connect(admin).pause();
      expect(await sp.paused()).to.be.true;
      await sp.connect(admin).unpause();
    });
  });

  describe("InvoiceFinancing — extra edges", function () {
    async function deployIF() {
      const [admin, treasury, creditor, debtor, factor, analyst, arbiter, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      const IF = await ethers.getContractFactory("InvoiceFinancing");
      const inv = await IF.deploy(admin.address, treasury.address, 100);
      await inv.connect(admin).grantRole(await inv.FACTOR_ROLE(), factor.address);
      await inv.connect(admin).grantRole(await inv.CREDIT_ANALYST_ROLE(), analyst.address);
      await inv.connect(admin).grantRole(await inv.ARBITER_ROLE(), arbiter.address);
      await inv.connect(admin).setSupportedToken(usdc.target, true);
      const amt = ethers.parseUnits("100000000", 6);
      for (const s of [factor, debtor, creditor, other]) {
        await usdc.mint(s.address, amt);
        await usdc.connect(s).approve(inv.target, ethers.MaxUint256);
      }
      return { inv, usdc, admin, treasury, creditor, debtor, factor, analyst, arbiter, other };
    }

    it("reverts createInvoice with zero admin in constructor", async function () {
      const IF = await ethers.getContractFactory("InvoiceFinancing");
      const [, t] = await ethers.getSigners();
      await expect(IF.deploy(ethers.ZeroAddress, t.address, 100))
        .to.be.revertedWithCustomError(IF, "ZeroAddress");
    });

    it("reverts excessive protocol fee in constructor", async function () {
      const IF = await ethers.getContractFactory("InvoiceFinancing");
      const [a, t] = await ethers.getSigners();
      await expect(IF.deploy(a.address, t.address, 2001)).to.be.revert(ethers);
    });

    it("batch create invoices succeeds", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await inv.connect(creditor).batchCreateInvoices(
        [debtor.address], [ethers.parseUnits("10000", 6)], usdc.target,
        [mat], [ethers.keccak256(ethers.toUtf8Bytes("doc"))], 7n * 86400n, 500
      );
    });

    it("chained invoice succeeds", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const FACE = ethers.parseUnits("50000", 6);
      const DOC = ethers.keccak256(ethers.toUtf8Bytes("doc"));
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      const mat2 = BigInt(await time.latest()) + 60n * 86400n;
      // Chained invoice must be created by the debtor of the parent invoice
      await inv.connect(debtor).createChainedInvoice(
        invId, creditor.address, FACE, mat2, DOC, 7n * 86400n, 500
      );
    });

    it("depositCollateral with zero amount reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const FACE = ethers.parseUnits("50000", 6);
      const DOC = ethers.keccak256(ethers.toUtf8Bytes("doc"));
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await expect(inv.connect(debtor).depositCollateral(invId, usdc.target, 0))
        .to.be.revertedWithCustomError(inv, "ZeroAmount");
    });

    it("pause and unpause", async function () {
      const { inv, admin } = await loadFixture(deployIF);
      await inv.connect(admin).pause();
      expect(await inv.paused()).to.be.true;
      await inv.connect(admin).unpause();
    });
  });
});
