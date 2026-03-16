const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

/**
 * BranchMax5 — targets modifier else-paths, not-found guards, and
 * multi-condition OR branches that are still uncovered.
 */
describe("BranchMax5", function () {

  // ═══════════════════════════════════════════════════════════════
  // InvoiceFinancing — not-found guards and OR-condition branches
  // ═══════════════════════════════════════════════════════════════
  describe("InvoiceFinancing — guard/OR branches", function () {
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

    const FACE = ethers.parseUnits("100000", 6);
    const DOC = ethers.keccak256(ethers.toUtf8Bytes("doc"));
    const FAKE_ID = ethers.keccak256(ethers.toUtf8Bytes("fake"));

    // Guard: if (inv.issuedAt == 0) revert InvoiceNotFound() — financeInvoice
    it("financeInvoice with non-existent invoice reverts", async function () {
      const { inv, factor } = await loadFixture(deployIF);
      await expect(inv.connect(factor).financeInvoice(FAKE_ID, 1000, 500)).to.be.reverted;
    });

    // Guard: if (inv.issuedAt == 0) — repayInvoice
    it("repayInvoice with non-existent invoice reverts", async function () {
      const { inv, debtor } = await loadFixture(deployIF);
      await expect(inv.connect(debtor).repayInvoice(FAKE_ID, 1000)).to.be.reverted;
    });

    // Guard: if (inv.issuedAt == 0) — markOverdue
    it("markOverdue with non-existent invoice reverts", async function () {
      const { inv, creditor } = await loadFixture(deployIF);
      await expect(inv.connect(creditor).markOverdue(FAKE_ID)).to.be.reverted;
    });

    // Guard: if (inv.issuedAt == 0) — initiateDispute
    it("initiateDispute with non-existent invoice reverts", async function () {
      const { inv, debtor } = await loadFixture(deployIF);
      await expect(inv.connect(debtor).initiateDispute(FAKE_ID, "test")).to.be.reverted;
    });

    // Guard: if (d.initiatedAt == 0) — resolveDispute
    it("resolveDispute with non-existent dispute reverts", async function () {
      const { inv, arbiter } = await loadFixture(deployIF);
      await expect(inv.connect(arbiter).resolveDispute(FAKE_ID, 1, 0, 0)).to.be.reverted;
    });

    // Guard: if (inv.issuedAt == 0) — depositCollateral
    it("depositCollateral with non-existent invoice reverts", async function () {
      const { inv, usdc, debtor } = await loadFixture(deployIF);
      await expect(inv.connect(debtor).depositCollateral(FAKE_ID, usdc.target, 1000)).to.be.reverted;
    });

    // Guard: if (inv.issuedAt == 0) — releaseCollateral
    it("releaseCollateral with non-existent invoice reverts", async function () {
      const { inv, debtor } = await loadFixture(deployIF);
      await expect(inv.connect(debtor).releaseCollateral(FAKE_ID, debtor.address)).to.be.reverted;
    });

    // Guard: if (inv.issuedAt == 0) — cancelInvoice
    it("cancelInvoice with non-existent invoice reverts", async function () {
      const { inv, creditor } = await loadFixture(deployIF);
      await expect(inv.connect(creditor).cancelInvoice(FAKE_ID)).to.be.reverted;
    });

    // Guard: if (parent.issuedAt == 0) — createChainedInvoice
    it("createChainedInvoice with non-existent parent reverts", async function () {
      const { inv, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(debtor).createChainedInvoice(
        FAKE_ID, debtor.address, FACE, mat, DOC, 7n * 86400n, 500
      )).to.be.reverted;
    });

    // depositCollateral with unsupported token
    it("depositCollateral with unsupported token reverts", async function () {
      const { inv, usdc, creditor, debtor, other } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await expect(inv.connect(debtor).depositCollateral(invId, other.address, 1000)).to.be.reverted;
    });

    // releaseCollateral already released
    it("releaseCollateral already released reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await inv.connect(debtor).depositCollateral(invId, usdc.target, ethers.parseUnits("5000", 6));
      await inv.connect(creditor).cancelInvoice(invId);
      await inv.connect(debtor).releaseCollateral(invId, debtor.address);
      // Try again - should revert
      await expect(inv.connect(debtor).releaseCollateral(invId, debtor.address)).to.be.reverted;
    });

    // releaseCollateral with zero collateral
    it("releaseCollateral with no collateral deposited reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await inv.connect(creditor).cancelInvoice(invId);
      await expect(inv.connect(debtor).releaseCollateral(invId, debtor.address)).to.be.reverted;
    });

    // batch create invoices with unsupported token
    it("batch create with unsupported token reverts", async function () {
      const { inv, debtor, creditor, other } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).batchCreateInvoices(
        [debtor.address], [FACE], other.address, [mat], [DOC], 7n * 86400n, 500
      )).to.be.reverted;
    });

    // batch create invoices with grace period too long
    it("batch create with excessive grace period reverts", async function () {
      const { inv, usdc, debtor, creditor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).batchCreateInvoices(
        [debtor.address], [FACE], usdc.target, [mat], [DOC], 91n * 86400n, 500
      )).to.be.reverted;
    });

    // batch create invoices with excessive penalty
    it("batch create with excessive penalty reverts", async function () {
      const { inv, usdc, debtor, creditor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).batchCreateInvoices(
        [debtor.address], [FACE], usdc.target, [mat], [DOC], 7n * 86400n, 2001
      )).to.be.reverted;
    });

    // chained invoice — face value 0
    it("chained invoice with zero face value reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      const mat2 = BigInt(await time.latest()) + 60n * 86400n;
      await expect(inv.connect(debtor).createChainedInvoice(
        invId, creditor.address, 0, mat2, DOC, 7n * 86400n, 500
      )).to.be.reverted;
    });

    // chained invoice — maturity in past
    it("chained invoice with maturity in past reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await expect(inv.connect(debtor).createChainedInvoice(
        invId, creditor.address, FACE, 1, DOC, 7n * 86400n, 500
      )).to.be.reverted;
    });

    // chained invoice — excessive grace
    it("chained invoice with excessive grace period reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      const mat2 = BigInt(await time.latest()) + 60n * 86400n;
      await expect(inv.connect(debtor).createChainedInvoice(
        invId, creditor.address, FACE, mat2, DOC, 91n * 86400n, 500
      )).to.be.reverted;
    });

    // chained invoice — excessive penalty
    it("chained invoice with excessive penalty reverts", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      const mat2 = BigInt(await time.latest()) + 60n * 86400n;
      await expect(inv.connect(debtor).createChainedInvoice(
        invId, creditor.address, FACE, mat2, DOC, 7n * 86400n, 2001
      )).to.be.reverted;
    });

    // resolve dispute with PENDING outcome reverts
    it("resolveDispute with PENDING outcome reverts", async function () {
      const { inv, usdc, creditor, debtor, factor, arbiter } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      const dtx = await inv.connect(debtor).initiateDispute(invId, "test");
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      // Try resolve with PENDING (0) — should revert
      await expect(inv.connect(arbiter).resolveDispute(dev.args[0], 0, 0, 0)).to.be.reverted;
    });

    // dispute on already-disputed reverts
    it("resolve already-resolved dispute reverts", async function () {
      const { inv, usdc, creditor, debtor, factor, arbiter } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const invId = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated").args[0];
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      const dtx = await inv.connect(debtor).initiateDispute(invId, "test");
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      await inv.connect(arbiter).resolveDispute(dev.args[0], 1, 0, 0);
      // Try again
      await expect(inv.connect(arbiter).resolveDispute(dev.args[0], 1, 0, 0)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // MultiSigTreasury — not-found guards
  // ═══════════════════════════════════════════════════════════════
  describe("MultiSigTreasury — guard branches", function () {
    async function deployMST() {
      const [admin, s1, s2, s3, s4, s5, other] = await ethers.getSigners();
      const MST = await ethers.getContractFactory("MultiSigTreasury");
      const mst = await MST.deploy(
        admin.address, [s1.address, s2.address, s3.address, s4.address, s5.address],
        2, 3, 4, 4
      );
      return { mst, admin, s1, s2, s3, s4, s5, other };
    }

    const FAKE_ID = ethers.keccak256(ethers.toUtf8Bytes("fake"));

    it("approveProposal non-existent reverts", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).approveProposal(FAKE_ID)).to.be.reverted;
    });

    it("rejectProposal non-existent reverts", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).rejectProposal(FAKE_ID)).to.be.reverted;
    });

    it("executeProposal non-existent reverts", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).executeProposal(FAKE_ID)).to.be.reverted;
    });

    it("cancelProposal non-existent reverts", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).cancelProposal(FAKE_ID)).to.be.reverted;
    });

    it("revokeRecurringPayment non-existent reverts", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).revokeRecurringPayment(FAKE_ID)).to.be.reverted;
    });

    it("executeRecurringPayment non-existent reverts", async function () {
      const { mst, s1 } = await loadFixture(deployMST);
      await expect(mst.connect(s1).executeRecurringPayment(FAKE_ID)).to.be.reverted;
    });

    it("approveYieldProtocol with zero address reverts", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await expect(mst.connect(admin).approveYieldProtocol(ethers.ZeroAddress, "test", 1000))
        .to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("removeSigner non-signer reverts", async function () {
      const { mst, admin, other } = await loadFixture(deployMST);
      await expect(mst.connect(admin).removeSigner(other.address))
        .to.be.revertedWithCustomError(mst, "NotSigner");
    });

    it("addSigner zero address reverts", async function () {
      const { mst, admin } = await loadFixture(deployMST);
      await expect(mst.connect(admin).addSigner(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(mst, "ZeroAddress");
    });

    it("recurring payment with zero amount reverts", async function () {
      const { mst, admin, s1, other } = await loadFixture(deployMST);
      await expect(mst.connect(admin).createRecurringPayment(
        other.address, ethers.ZeroAddress, 0, 0, 0, "test", 0, ethers.ZeroHash
      )).to.be.revertedWithCustomError(mst, "ZeroAmount");
    });

    it("reject non-PENDING proposal reverts", async function () {
      const { mst, admin, s1, s2, s3, s4, s5 } = await loadFixture(deployMST);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      await mst.connect(admin).setSupportedToken(usdc.target, true);
      const tx = await mst.connect(s1).createProposal(
        s2.address, usdc.target, 1000, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      // Reject until auto-rejected
      await mst.connect(s2).rejectProposal(pid);
      await mst.connect(s3).rejectProposal(pid);
      await mst.connect(s4).rejectProposal(pid);
      await mst.connect(s5).rejectProposal(pid);
      // Now try to reject again on already-REJECTED proposal
      await expect(mst.connect(admin).rejectProposal(pid)).to.be.reverted;
    });

    it("approve non-PENDING proposal reverts", async function () {
      const { mst, admin, s1, s2, s3, s4, s5 } = await loadFixture(deployMST);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      await mst.connect(admin).setSupportedToken(usdc.target, true);
      const tx = await mst.connect(s1).createProposal(
        s2.address, usdc.target, 1000, 0, "test", false, ethers.ZeroHash
      );
      const r = await tx.wait();
      const pid = r.logs.find(l => l.fragment && l.fragment.name === "ProposalCreated").args[0];
      await mst.connect(s2).rejectProposal(pid);
      await mst.connect(s3).rejectProposal(pid);
      await mst.connect(s4).rejectProposal(pid);
      await mst.connect(s5).rejectProposal(pid);
      await expect(mst.connect(admin).approveProposal(pid)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // NoblePay — not-found and monthly limit
  // ═══════════════════════════════════════════════════════════════
  describe("NoblePay — guard branches", function () {
    async function deployNP() {
      const [admin, treasury, teeNode, officer, sender, recipient, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const usdc = await MockERC20.deploy("USDC", "USDC", 6);
      const NP = await ethers.getContractFactory("NoblePay");
      const np = await NP.deploy(admin.address, treasury.address, 0, 50);
      await np.connect(admin).grantRole(await np.TEE_NODE_ROLE(), teeNode.address);
      await np.connect(admin).grantRole(await np.COMPLIANCE_OFFICER_ROLE(), officer.address);
      await np.connect(admin).setSupportedToken(usdc.target, true);
      await np.connect(admin).syncBusiness(sender.address, 0, true);
      const amt = ethers.parseUnits("100000000", 6);
      await usdc.mint(sender.address, amt);
      await usdc.connect(sender).approve(np.target, ethers.MaxUint256);
      return { np, usdc, admin, treasury, teeNode, officer, sender, recipient, other };
    }

    const FAKE_ID = ethers.keccak256(ethers.toUtf8Bytes("fake"));
    const PURPOSE = ethers.keccak256(ethers.toUtf8Bytes("p"));

    it("settlePayment non-existent reverts", async function () {
      const { np, sender } = await loadFixture(deployNP);
      await expect(np.connect(sender).settlePayment(FAKE_ID)).to.be.reverted;
    });

    it("refundPayment non-existent reverts", async function () {
      const { np, sender } = await loadFixture(deployNP);
      await expect(np.connect(sender).refundPayment(FAKE_ID)).to.be.reverted;
    });

    it("cancelPayment non-existent reverts", async function () {
      const { np, sender } = await loadFixture(deployNP);
      await expect(np.connect(sender).cancelPayment(FAKE_ID)).to.be.reverted;
    });

    it("compliance on non-existent payment reverts", async function () {
      const { np, teeNode } = await loadFixture(deployNP);
      await expect(np.connect(teeNode).submitComplianceResult(
        FAKE_ID, true, 30, true, ethers.ZeroHash, "0x"
      )).to.be.reverted;
    });

    it("monthly volume limit exceeded", async function () {
      const { np, usdc, admin, sender, recipient } = await loadFixture(deployNP);
      // Use STANDARD tier: daily=50K, monthly=500K
      // Send just under daily limit each day for 11 days to exceed monthly
      // 11 * 49999 = 549989 > 500000 monthly limit
      // First, advance time to the start of a fresh 30-day period to avoid boundary issues
      const THIRTY_DAYS = 30 * 86400;
      const now = await time.latest();
      const nextMonth = (Math.floor(now / THIRTY_DAYS) + 1) * THIRTY_DAYS;
      await time.increaseTo(nextMonth + 10); // just past the start of a new month bucket

      const amt = ethers.parseUnits("49999", 6); // just under daily 50K limit
      for (let i = 0; i < 10; i++) {
        await usdc.mint(sender.address, amt);
        await np.connect(sender).initiatePayment(
          recipient.address, amt, usdc.target, PURPOSE, "0x414544"
        );
        await time.increase(86400);
      }
      // Total: 499990. One more should exceed 500K monthly.
      await usdc.mint(sender.address, amt);
      await expect(np.connect(sender).initiatePayment(
        recipient.address, amt, usdc.target, PURPOSE, "0x414544"
      )).to.be.revertedWithCustomError(np, "MonthlyLimitExceeded");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CrossChainRouter — not-found guards, reputation paths
  // ═══════════════════════════════════════════════════════════════
  describe("CrossChainRouter — guard branches", function () {
    async function deployCCR() {
      const [admin, relay1, sender, treasury, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      const CCR = await ethers.getContractFactory("CrossChainRouter");
      const ccr = await CCR.deploy(admin.address, treasury.address);
      await ccr.connect(admin).setTokenSupport(token.target, true);
      await ccr.connect(admin).addChain(137, "Polygon", ethers.parseUnits("10", 6), 50, 128, 4 * 3600, ethers.parseUnits("100", 6), ethers.parseUnits("1000000", 6));
      const amt = ethers.parseUnits("10000000", 6);
      await token.mint(sender.address, amt);
      await token.connect(sender).approve(ccr.target, ethers.MaxUint256);
      await token.mint(ccr.target, amt);
      return { ccr, token, admin, relay1, sender, treasury, other };
    }

    const FAKE_ID = ethers.keccak256(ethers.toUtf8Bytes("fake"));

    it("submitRelayProof non-existent transfer reverts", async function () {
      const { ccr, relay1 } = await loadFixture(deployCCR);
      await ccr.connect(relay1).registerRelay({ value: ethers.parseEther("5") });
      const destTx = ethers.keccak256(ethers.toUtf8Bytes("dest"));
      await expect(ccr.connect(relay1).submitRelayProof(FAKE_ID, destTx, "0x")).to.be.reverted;
    });

    it("confirmTransfer non-existent reverts", async function () {
      const { ccr, admin } = await loadFixture(deployCCR);
      await expect(ccr.connect(admin).confirmTransfer(FAKE_ID)).to.be.reverted;
    });

    it("markTransferFailed non-existent reverts", async function () {
      const { ccr, admin } = await loadFixture(deployCCR);
      await expect(ccr.connect(admin).markTransferFailed(FAKE_ID, "fail")).to.be.reverted;
    });

    it("recoverTransfer non-existent reverts", async function () {
      const { ccr, sender } = await loadFixture(deployCCR);
      await expect(ccr.connect(sender).recoverTransfer(FAKE_ID)).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // LiquidityPool — not-found guards
  // ═══════════════════════════════════════════════════════════════
  describe("LiquidityPool — guard branches", function () {
    it("removeLiquidity non-active position reverts", async function () {
      const [admin, treasury, lp1] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const t0 = await MockERC20.deploy("T0", "T0", 18);
      const t1 = await MockERC20.deploy("T1", "T1", 18);
      let token0 = t0, token1 = t1;
      if (BigInt(t0.target) > BigInt(t1.target)) { token0 = t1; token1 = t0; }
      const LP = await ethers.getContractFactory("LiquidityPool");
      const pool = await LP.deploy(admin.address, treasury.address);
      await pool.connect(admin).grantRole(await pool.POOL_ADMIN_ROLE(), admin.address);
      await pool.connect(admin).grantRole(await pool.LIQUIDITY_PROVIDER_ROLE(), lp1.address);
      const amt = ethers.parseEther("1000000");
      await token0.mint(lp1.address, amt);
      await token1.mint(lp1.address, amt);
      await token0.connect(lp1).approve(pool.target, ethers.MaxUint256);
      await token1.connect(lp1).approve(pool.target, ethers.MaxUint256);
      const tx = await pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 500);
      const r = await tx.wait();
      const poolId = r.logs.find(l => l.fragment && l.fragment.name === "PoolCreated").args[0];
      // Use a fake positionId that was never created — position not active
      const fakePos = ethers.keccak256(ethers.toUtf8Bytes("fake-position"));
      await expect(pool.connect(lp1).removeLiquidity(poolId, fakePos)).to.be.reverted;
    });
  });
});
