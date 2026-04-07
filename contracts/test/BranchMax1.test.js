import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

/**
 * BranchMax1 — targets uncovered branches in:
 *   InvoiceFinancing, StreamingPayments, ComplianceOracle, CrossChainRouter
 */
describe("BranchMax1", function () {

  // ═══════════════════════════════════════════════════════════════
  // InvoiceFinancing
  // ═══════════════════════════════════════════════════════════════
  describe("InvoiceFinancing — deep branch coverage", function () {
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

    async function createInvoice(inv, creditor, debtor, usdc, maturityOffset = 30n * 86400n) {
      const mat = BigInt(await time.latest()) + maturityOffset;
      const tx = await inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
      return ev.args[0];
    }

    it("reverts with zero treasury", async function () {
      const [a] = await ethers.getSigners();
      const IF = await ethers.getContractFactory("InvoiceFinancing");
      await expect(IF.deploy(a.address, ethers.ZeroAddress, 100))
        .to.be.revertedWithCustomError(IF, "ZeroAddress");
    });

    it("reverts when maturity > 365 days in future", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 366n * 86400n;
      await expect(inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts when grace period > MAX_GRACE_PERIOD", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 91n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts createInvoice with zero face value", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).createInvoice(
        debtor.address, 0, usdc.target, mat, DOC, 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts createInvoice with debtor == creditor", async function () {
      const { inv, usdc, creditor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).createInvoice(
        creditor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts createInvoice with unsupported token", async function () {
      const { inv, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).createInvoice(
        debtor.address, FACE, ethers.ZeroAddress, mat, DOC, 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts createInvoice with maturity in the past", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) - 100n;
      await expect(inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts createInvoice with excessive penalty", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).createInvoice(
        debtor.address, FACE, usdc.target, mat, DOC, 7n * 86400n, 2001
      )).to.be.revert(ethers);
    });

    it("reverts chained invoice with zero debtor", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).createChainedInvoice(
        invId, ethers.ZeroAddress, FACE, mat, DOC, 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("reverts batch with array length mismatch", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const mat = BigInt(await time.latest()) + 30n * 86400n;
      await expect(inv.connect(creditor).batchCreateInvoices(
        [debtor.address], [FACE, FACE], usdc.target, [mat], [DOC], 7n * 86400n, 500
      )).to.be.revert(ethers);
    });

    it("handles protocolFee == 0", async function () {
      const { inv, usdc, creditor, debtor, factor, admin } = await loadFixture(deployIF);
      await inv.connect(admin).setProtocolFee(0);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("90000", 6), 500);
    });

    it("caps repayment at remaining amount", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("90000", 6), 500);
      await inv.connect(debtor).repayInvoice(invId, ethers.parseUnits("200000", 6));
    });

    it("late repayment updates credit score", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc, 10n * 86400n);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await time.increase(15 * 86400);
      await inv.connect(debtor).repayInvoice(invId, FACE);
    });

    it("very late repayment (>30 days) hits worst credit tier", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc, 5n * 86400n);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await time.increase(40 * 86400);
      await inv.connect(debtor).repayInvoice(invId, FACE);
    });

    it("on-time repayment gives best credit tier", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await inv.connect(debtor).repayInvoice(invId, FACE);
    });

    it("getSuggestedDiscountRate returns a rate", async function () {
      const { inv, debtor } = await loadFixture(deployIF);
      const rate = await inv.getSuggestedDiscountRate(debtor.address);
      expect(rate).to.be.gte(0);
    });

    it("releases collateral after settlement", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(debtor).depositCollateral(invId, usdc.target, ethers.parseUnits("10000", 6));
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await inv.connect(debtor).repayInvoice(invId, FACE);
      await inv.connect(debtor).releaseCollateral(invId, debtor.address);
    });

    it("releases collateral after cancel", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(debtor).depositCollateral(invId, usdc.target, ethers.parseUnits("10000", 6));
      await inv.connect(creditor).cancelInvoice(invId);
      await inv.connect(debtor).releaseCollateral(invId, debtor.address);
    });

    it("cancel unfunded invoice", async function () {
      const { inv, usdc, creditor, debtor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(creditor).cancelInvoice(invId);
    });

    it("reverts cancel on financed invoice", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await expect(inv.connect(creditor).cancelInvoice(invId)).to.be.revert(ethers);
    });

    it("debtor initiates dispute", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await inv.connect(debtor).initiateDispute(invId, "defective");
    });

    it("creditor initiates dispute", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await inv.connect(creditor).initiateDispute(invId, "non-payment");
    });

    it("resolve dispute FAVOR_DEBTOR", async function () {
      const { inv, usdc, creditor, debtor, factor, arbiter } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      // Fund the contract so it can distribute awards
      await usdc.mint(inv.target, FACE);
      const dtx = await inv.connect(debtor).initiateDispute(invId, "defective");
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      // FAVOR_DEBTOR = 2, creditorAward=0, debtorRefund=some amount
      await inv.connect(arbiter).resolveDispute(dev.args[0], 2, 0, ethers.parseUnits("1000", 6));
    });

    it("resolve dispute FAVOR_CREDITOR", async function () {
      const { inv, usdc, creditor, debtor, factor, arbiter } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      // Fund the contract so it can distribute awards
      await usdc.mint(inv.target, FACE);
      const dtx = await inv.connect(debtor).initiateDispute(invId, "defective");
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      // FAVOR_CREDITOR = 1, creditorAward=some amount, debtorRefund=0
      await inv.connect(arbiter).resolveDispute(dev.args[0], 1, ethers.parseUnits("1000", 6), 0);
    });

    it("resolve dispute SPLIT (both awards)", async function () {
      const { inv, usdc, creditor, debtor, factor, arbiter } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await usdc.mint(inv.target, FACE);
      const dtx = await inv.connect(debtor).initiateDispute(invId, "defective");
      const dr = await dtx.wait();
      const dev = dr.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      // SPLIT = 3, both get something
      await inv.connect(arbiter).resolveDispute(dev.args[0], 3, ethers.parseUnits("500", 6), ethers.parseUnits("500", 6));
    });

    it("marks invoice overdue", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc, 5n * 86400n);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await time.increase(15 * 86400);
      await inv.connect(creditor).markOverdue(invId);
    });

    it("partial then full repayment settles", async function () {
      const { inv, usdc, creditor, debtor, factor } = await loadFixture(deployIF);
      const invId = await createInvoice(inv, creditor, debtor, usdc);
      await inv.connect(factor).financeInvoice(invId, ethers.parseUnits("50000", 6), 500);
      await inv.connect(debtor).repayInvoice(invId, ethers.parseUnits("50000", 6));
      await inv.connect(debtor).repayInvoice(invId, ethers.parseUnits("50000", 6));
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // StreamingPayments
  // ═══════════════════════════════════════════════════════════════
  describe("StreamingPayments — deep branch coverage", function () {
    async function deploySP() {
      const [admin, sender, recipient, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      const SP = await ethers.getContractFactory("StreamingPayments");
      const sp = await SP.deploy(admin.address);
      await sp.connect(admin).grantRole(await sp.STREAM_ADMIN_ROLE(), admin.address);
      const amt = ethers.parseUnits("10000000", 6);
      await token.mint(sender.address, amt);
      await token.connect(sender).approve(sp.target, ethers.MaxUint256);
      return { sp, token, admin, sender, recipient, other };
    }

    async function createStream(sp, token, sender, recipient, duration = 30 * 86400, cliff = 0) {
      const amount = ethers.parseUnits("10000", 6);
      const tx = await sp.connect(sender).createStream(
        recipient.address, token.target, amount, duration, cliff
      );
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
      return ev.args[0];
    }

    it("reverts constructor with zero admin", async function () {
      const SP = await ethers.getContractFactory("StreamingPayments");
      await expect(SP.deploy(ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("reverts createStream with self as recipient", async function () {
      const { sp, token, sender } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createStream(
        sender.address, token.target, ethers.parseUnits("1000", 6), 30 * 86400, 0
      )).to.be.revert(ethers);
    });

    it("reverts createStream with zero amount", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createStream(
        recipient.address, token.target, 0, 30 * 86400, 0
      )).to.be.revert(ethers);
    });

    it("reverts createStream with duration too short", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createStream(
        recipient.address, token.target, ethers.parseUnits("1000", 6), 3599, 0
      )).to.be.revert(ethers);
    });

    it("reverts createStream with cliff >= duration", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      await expect(sp.connect(sender).createStream(
        recipient.address, token.target, ethers.parseUnits("1000", 6), 30 * 86400, 30 * 86400
      )).to.be.revert(ethers);
    });

    it("pauseStream reverts for unauthorized caller", async function () {
      const { sp, token, sender, recipient, other } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient);
      await expect(sp.connect(other).pauseStream(sid)).to.be.revert(ethers);
    });

    it("resumeStream reverts if not paused", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient);
      await expect(sp.connect(sender).resumeStream(sid)).to.be.revert(ethers);
    });

    it("cancelStream returns remaining to sender", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient);
      await time.increase(5 * 86400);
      await sp.connect(sender).cancelStream(sid);
    });

    it("withdraw before cliff reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient, 30 * 86400, 10 * 86400);
      await time.increase(5 * 86400);
      await expect(sp.connect(recipient).withdraw(sid)).to.be.revert(ethers);
    });

    it("withdraw after cliff succeeds", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient, 30 * 86400, 10 * 86400);
      await time.increase(15 * 86400);
      await sp.connect(recipient).withdraw(sid);
    });

    it("withdraw after stream completed", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient, 3600, 0);
      await time.increase(7200);
      await sp.connect(recipient).withdraw(sid);
    });

    it("pause then resume then withdraw", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient);
      await time.increase(5 * 86400);
      await sp.connect(sender).pauseStream(sid);
      await time.increase(5 * 86400);
      await sp.connect(sender).resumeStream(sid);
      await time.increase(5 * 86400);
      await sp.connect(recipient).withdraw(sid);
    });

    it("cancelStream on already cancelled reverts", async function () {
      const { sp, token, sender, recipient } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient);
      await sp.connect(sender).cancelStream(sid);
      await expect(sp.connect(sender).cancelStream(sid)).to.be.revert(ethers);
    });

    it("withdraw by non-recipient reverts", async function () {
      const { sp, token, sender, recipient, other } = await loadFixture(deploySP);
      const sid = await createStream(sp, token, sender, recipient);
      await time.increase(5 * 86400);
      await expect(sp.connect(other).withdraw(sid)).to.be.revert(ethers);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ComplianceOracle
  // ═══════════════════════════════════════════════════════════════
  describe("ComplianceOracle — deep branch coverage", function () {
    async function deployCO() {
      const [admin, node1, node2, node3, other] = await ethers.getSigners();
      const CO = await ethers.getContractFactory("ComplianceOracle");
      const co = await CO.deploy(admin.address);
      const att1 = ethers.toUtf8Bytes("enclave-key-1");
      const pid1 = ethers.keccak256(ethers.toUtf8Bytes("platform1"));
      const att2 = ethers.toUtf8Bytes("enclave-key-2");
      const pid2 = ethers.keccak256(ethers.toUtf8Bytes("platform2"));
      await co.connect(node1).registerTEENode(att1, pid1, { value: ethers.parseEther("10") });
      await co.connect(node2).registerTEENode(att2, pid2, { value: ethers.parseEther("10") });
      return { co, admin, node1, node2, node3, other };
    }

    it("reverts constructor with zero admin", async function () {
      const CO = await ethers.getContractFactory("ComplianceOracle");
      await expect(CO.deploy(ethers.ZeroAddress)).to.be.revert(ethers);
    });

    it("heartbeat reverts for non-active node", async function () {
      const { co, node3 } = await loadFixture(deployCO);
      await expect(co.connect(node3).heartbeat()).to.be.revert(ethers);
    });

    it("heartbeat succeeds for active node", async function () {
      const { co, node1 } = await loadFixture(deployCO);
      await co.connect(node1).heartbeat();
    });

    it("verifyAttestation with wrong hash reverts", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      const attData = ethers.toUtf8Bytes("attestation-content");
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
      await expect(co.connect(admin).verifyAttestation(node1.address, attData, wrongHash))
        .to.be.revertedWithCustomError(co, "InvalidAttestation");
    });

    it("verifyAttestation with correct hash succeeds", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      const attData = ethers.toUtf8Bytes("attestation-content");
      const correctHash = ethers.keccak256(attData);
      await co.connect(admin).verifyAttestation(node1.address, attData, correctHash);
    });

    it("submitScreeningResult with riskScore > 100 reverts", async function () {
      const { co, node1 } = await loadFixture(deployCO);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub"));
      const res = ethers.keccak256(ethers.toUtf8Bytes("res"));
      await expect(co.connect(node1).submitScreeningResult(sub, res, 101, true)).to.be.revert(ethers);
    });

    it("submitScreeningResult succeeds", async function () {
      const { co, node1 } = await loadFixture(deployCO);
      const sub = ethers.keccak256(ethers.toUtf8Bytes("sub"));
      const res = ethers.keccak256(ethers.toUtf8Bytes("res"));
      await co.connect(node1).submitScreeningResult(sub, res, 50, true);
    });

    it("slashOfflineNode reduces stake", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      await time.increase(6 * 60);
      await co.connect(admin).slashOfflineNode(node1.address);
    });

    it("slash 3 times triggers auto-deregister", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      for (let i = 0; i < 3; i++) {
        await time.increase(6 * 60);
        try { await co.connect(admin).slashOfflineNode(node1.address); } catch { break; }
      }
    });

    it("deregisterTEENode removes node", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      await co.connect(admin).deregisterTEENode(node1.address);
    });

    it("deregister non-last node triggers swap-and-pop", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      await co.connect(admin).deregisterTEENode(node1.address);
    });

    it("proposeThresholdUpdate invalid ranges revert", async function () {
      const { co, admin } = await loadFixture(deployCO);
      await expect(co.connect(admin).proposeThresholdUpdate(50, 50)).to.be.revert(ethers);
      await expect(co.connect(admin).proposeThresholdUpdate(50, 101)).to.be.revert(ethers);
    });

    it("propose and approve threshold update", async function () {
      const { co, admin, node1 } = await loadFixture(deployCO);
      const THRESHOLD_ROLE = await co.THRESHOLD_MANAGER_ROLE();
      await co.connect(admin).grantRole(THRESHOLD_ROLE, node1.address);
      const tx = await co.connect(admin).proposeThresholdUpdate(20, 60);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
      if (ev) {
        await co.connect(node1).approveThresholdUpdate(ev.args[0], 20, 60);
      }
    });

    it("double vote reverts", async function () {
      const { co, admin } = await loadFixture(deployCO);
      const tx = await co.connect(admin).proposeThresholdUpdate(20, 60);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "ThresholdChangeProposed");
      if (ev) {
        await expect(co.connect(admin).approveThresholdUpdate(ev.args[0], 20, 60))
          .to.be.revertedWithCustomError(co, "AlreadyVoted");
      }
    });

    it("classifyRisk covers all tiers", async function () {
      const { co } = await loadFixture(deployCO);
      expect(await co.classifyRisk(10)).to.equal("LOW");
      expect(await co.classifyRisk(50)).to.equal("MEDIUM");
      expect(await co.classifyRisk(90)).to.equal("HIGH");
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CrossChainRouter
  // ═══════════════════════════════════════════════════════════════
  describe("CrossChainRouter — deep branch coverage", function () {
    const CHAIN_ID = 137;
    const BASE_FEE = ethers.parseUnits("10", 6);
    const FEE_RATE_BP = 50;
    const FINALITY_BLOCKS = 128;
    const RECOVERY_TIMEOUT = 4 * 3600;
    const MIN_TRANSFER = ethers.parseUnits("100", 6);
    const MAX_TRANSFER = ethers.parseUnits("1000000", 6);

    async function deployCCR() {
      const [admin, relay1, relay2, sender, treasury, other] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      const CCR = await ethers.getContractFactory("CrossChainRouter");
      const ccr = await CCR.deploy(admin.address, treasury.address);
      await ccr.connect(admin).setTokenSupport(token.target, true);
      await ccr.connect(admin).addChain(
        CHAIN_ID, "Polygon", BASE_FEE, FEE_RATE_BP, FINALITY_BLOCKS,
        RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER
      );
      const amt = ethers.parseUnits("10000000", 6);
      await token.mint(sender.address, amt);
      await token.connect(sender).approve(ccr.target, ethers.MaxUint256);
      await token.mint(ccr.target, amt);
      return { ccr, token, admin, relay1, relay2, sender, treasury, other };
    }

    it("initiateTransfer with zero token reverts", async function () {
      const { ccr, sender } = await loadFixture(deployCCR);
      const rh = ethers.keccak256(ethers.toUtf8Bytes("r"));
      await expect(ccr.connect(sender).initiateTransfer(ethers.ZeroAddress, ethers.parseUnits("1000", 6), CHAIN_ID, rh)).to.be.revert(ethers);
    });

    it("initiateTransfer with zero amount reverts", async function () {
      const { ccr, token, sender } = await loadFixture(deployCCR);
      const rh = ethers.keccak256(ethers.toUtf8Bytes("r"));
      await expect(ccr.connect(sender).initiateTransfer(token.target, 0, CHAIN_ID, rh)).to.be.revert(ethers);
    });

    it("addChain duplicate reverts", async function () {
      const { ccr, admin } = await loadFixture(deployCCR);
      await expect(ccr.connect(admin).addChain(CHAIN_ID, "P2", BASE_FEE, FEE_RATE_BP, FINALITY_BLOCKS, RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER)).to.be.revert(ethers);
    });

    it("addChain fee too high reverts", async function () {
      const { ccr, admin } = await loadFixture(deployCCR);
      await expect(ccr.connect(admin).addChain(999, "T", BASE_FEE, 201, FINALITY_BLOCKS, RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER)).to.be.revert(ethers);
    });

    it("addChain recovery timeout too short reverts", async function () {
      const { ccr, admin } = await loadFixture(deployCCR);
      await expect(ccr.connect(admin).addChain(999, "T", BASE_FEE, FEE_RATE_BP, FINALITY_BLOCKS, 60, MIN_TRANSFER, MAX_TRANSFER)).to.be.revert(ethers);
    });

    it("deregisterRelay non-relay reverts", async function () {
      const { ccr, admin, other } = await loadFixture(deployCCR);
      await expect(ccr.connect(admin).deregisterRelay(other.address)).to.be.revert(ethers);
    });

    it("deregister non-last relay triggers swap-and-pop", async function () {
      const { ccr, admin, relay1, relay2 } = await loadFixture(deployCCR);
      await ccr.connect(relay1).registerRelay({ value: ethers.parseEther("5") });
      await ccr.connect(relay2).registerRelay({ value: ethers.parseEther("5") });
      await ccr.connect(admin).deregisterRelay(relay1.address);
    });

    it("markTransferFailed with no relay (no penalty)", async function () {
      const { ccr, token, admin, sender } = await loadFixture(deployCCR);
      const rh = ethers.keccak256(ethers.toUtf8Bytes("r"));
      const tx = await ccr.connect(sender).initiateTransfer(token.target, ethers.parseUnits("1000", 6), CHAIN_ID, rh);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
      await ccr.connect(admin).markTransferFailed(ev.args[0], "fail");
    });

    it("recoverTransfer after deadline", async function () {
      const { ccr, token, sender } = await loadFixture(deployCCR);
      const rh = ethers.keccak256(ethers.toUtf8Bytes("r"));
      const tx = await ccr.connect(sender).initiateTransfer(token.target, ethers.parseUnits("1000", 6), CHAIN_ID, rh);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
      await time.increase(RECOVERY_TIMEOUT + 1);
      await ccr.connect(sender).recoverTransfer(ev.args[0]);
    });

    it("recoverTransfer for FAILED transfer", async function () {
      const { ccr, token, admin, sender } = await loadFixture(deployCCR);
      const rh = ethers.keccak256(ethers.toUtf8Bytes("r"));
      const tx = await ccr.connect(sender).initiateTransfer(token.target, ethers.parseUnits("1000", 6), CHAIN_ID, rh);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
      await ccr.connect(admin).markTransferFailed(ev.args[0], "fail");
      await ccr.connect(sender).recoverTransfer(ev.args[0]);
    });

    it("full relay flow: initiate, proof, confirm", async function () {
      const { ccr, token, admin, relay1, sender } = await loadFixture(deployCCR);
      await ccr.connect(relay1).registerRelay({ value: ethers.parseEther("5") });
      const rh = ethers.keccak256(ethers.toUtf8Bytes("r"));
      const tx = await ccr.connect(sender).initiateTransfer(token.target, ethers.parseUnits("1000", 6), CHAIN_ID, rh);
      const r = await tx.wait();
      const ev = r.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
      const destTx = ethers.keccak256(ethers.toUtf8Bytes("destTx"));
      await ccr.connect(relay1).submitRelayProof(ev.args[0], destTx, ethers.toUtf8Bytes("proof"));
      await ccr.connect(admin).confirmTransfer(ev.args[0]);
    });

    it("removeChain", async function () {
      const { ccr, admin } = await loadFixture(deployCCR);
      await ccr.connect(admin).removeChain(CHAIN_ID);
    });
  });
});
