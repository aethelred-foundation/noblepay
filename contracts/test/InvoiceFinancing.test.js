const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("InvoiceFinancing", function () {
  async function deployFixture() {
    const [admin, treasuryAddr, creditor, debtor, factor, analyst, arbiter, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const IF = await ethers.getContractFactory("InvoiceFinancing");
    const invoiceF = await IF.deploy(admin.address, treasuryAddr.address, 100); // 1% protocol fee

    // Grant roles
    await invoiceF.connect(admin).grantRole(await invoiceF.FACTOR_ROLE(), factor.address);
    await invoiceF.connect(admin).grantRole(await invoiceF.CREDIT_ANALYST_ROLE(), analyst.address);
    await invoiceF.connect(admin).grantRole(await invoiceF.ARBITER_ROLE(), arbiter.address);

    // Setup token
    await invoiceF.connect(admin).setSupportedToken(usdc.target, true);

    // Mint tokens
    const amt = ethers.parseUnits("10000000", 6);
    await usdc.mint(factor.address, amt);
    await usdc.mint(debtor.address, amt);
    await usdc.mint(creditor.address, amt);
    await usdc.connect(factor).approve(invoiceF.target, ethers.MaxUint256);
    await usdc.connect(debtor).approve(invoiceF.target, ethers.MaxUint256);
    await usdc.connect(creditor).approve(invoiceF.target, ethers.MaxUint256);

    return { invoiceF, usdc, admin, treasuryAddr, creditor, debtor, factor, analyst, arbiter, other };
  }

  const FACE_VALUE = ethers.parseUnits("100000", 6); // $100k
  const DOC_HASH = ethers.keccak256(ethers.toUtf8Bytes("invoice-doc"));

  async function invoiceCreatedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { invoiceF, usdc, creditor, debtor } = fixture;
    const maturity = BigInt(await time.latest()) + 86400n * 30n; // 30 days
    const tx = await invoiceF.connect(creditor).createInvoice(
      debtor.address, FACE_VALUE, usdc.target, maturity, DOC_HASH, 86400n * 7n, 500 // 7 day grace, 5% penalty
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];
    return { ...fixture, invoiceId, maturity };
  }

  async function financedFixture() {
    const fixture = await invoiceCreatedFixture();
    const { invoiceF, factor, invoiceId } = fixture;
    const advance = ethers.parseUnits("90000", 6); // 90% advance
    const tx = await invoiceF.connect(factor).financeInvoice(invoiceId, advance, 500); // 5% discount
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceFinanced");
    const positionId = event.args[1];
    return { ...fixture, positionId, advance };
  }

  describe("Deployment", function () {
    it("should set admin and treasury", async function () {
      const { invoiceF, admin, treasuryAddr } = await loadFixture(deployFixture);
      expect(await invoiceF.protocolTreasury()).to.equal(treasuryAddr.address);
      expect(await invoiceF.protocolFeeBps()).to.equal(100);
    });

    it("should revert with zero admin", async function () {
      const IF = await ethers.getContractFactory("InvoiceFinancing");
      const [, t] = await ethers.getSigners();
      await expect(IF.deploy(ethers.ZeroAddress, t.address, 100))
        .to.be.revertedWithCustomError(IF, "ZeroAddress");
    });

    it("should revert with excessive fee", async function () {
      const IF = await ethers.getContractFactory("InvoiceFinancing");
      const [a, t] = await ethers.getSigners();
      await expect(IF.deploy(a.address, t.address, 1001))
        .to.be.revertedWithCustomError(IF, "InvalidFee");
    });
  });

  describe("Invoice Creation", function () {
    it("should create an invoice", async function () {
      const { invoiceF, usdc, creditor, debtor } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(invoiceF.connect(creditor).createInvoice(
        debtor.address, FACE_VALUE, usdc.target, maturity, DOC_HASH, 0, 0
      )).to.emit(invoiceF, "InvoiceCreated");
    });

    it("should revert for zero debtor", async function () {
      const { invoiceF, usdc, creditor } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(invoiceF.connect(creditor).createInvoice(
        ethers.ZeroAddress, FACE_VALUE, usdc.target, maturity, DOC_HASH, 0, 0
      )).to.be.revertedWithCustomError(invoiceF, "ZeroAddress");
    });

    it("should revert for self-invoice", async function () {
      const { invoiceF, usdc, creditor } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(invoiceF.connect(creditor).createInvoice(
        creditor.address, FACE_VALUE, usdc.target, maturity, DOC_HASH, 0, 0
      )).to.be.revertedWithCustomError(invoiceF, "NotInvoiceParty");
    });

    it("should revert for unsupported token", async function () {
      const { invoiceF, creditor, debtor, other } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(invoiceF.connect(creditor).createInvoice(
        debtor.address, FACE_VALUE, other.address, maturity, DOC_HASH, 0, 0
      )).to.be.revertedWithCustomError(invoiceF, "UnsupportedToken");
    });

    it("should revert for maturity in the past", async function () {
      const { invoiceF, usdc, creditor, debtor } = await loadFixture(deployFixture);
      await expect(invoiceF.connect(creditor).createInvoice(
        debtor.address, FACE_VALUE, usdc.target, 1, DOC_HASH, 0, 0
      )).to.be.revertedWithCustomError(invoiceF, "MaturityInPast");
    });

    it("should revert for excessive late penalty", async function () {
      const { invoiceF, usdc, creditor, debtor } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(invoiceF.connect(creditor).createInvoice(
        debtor.address, FACE_VALUE, usdc.target, maturity, DOC_HASH, 0, 2001
      )).to.be.revertedWithCustomError(invoiceF, "InvalidPenaltyRate");
    });

    it("should initialize credit profiles", async function () {
      const { invoiceF, creditor, debtor } = await invoiceCreatedFixture();
      const cp = await invoiceF.getCreditProfile(creditor.address);
      expect(cp.creditScore).to.equal(550); // DEFAULT_CREDIT_SCORE
      expect(cp.totalInvoicesIssued).to.equal(1);
    });
  });

  describe("Invoice Chaining", function () {
    it("should create a chained invoice", async function () {
      const { invoiceF, usdc, debtor, other, invoiceId } = await invoiceCreatedFixture();
      const maturity = BigInt(await time.latest()) + 86400n * 60n;
      await expect(invoiceF.connect(debtor).createChainedInvoice(
        invoiceId, other.address, FACE_VALUE / 2n, maturity, DOC_HASH, 0, 0
      )).to.emit(invoiceF, "InvoiceChainLinked");
    });

    it("should revert if not debtor of parent", async function () {
      const { invoiceF, creditor, other, invoiceId } = await invoiceCreatedFixture();
      const maturity = BigInt(await time.latest()) + 86400n * 60n;
      await expect(invoiceF.connect(creditor).createChainedInvoice(
        invoiceId, other.address, FACE_VALUE / 2n, maturity, DOC_HASH, 0, 0
      )).to.be.revertedWithCustomError(invoiceF, "NotDebtor");
    });
  });

  describe("Factoring", function () {
    it("should finance an invoice", async function () {
      const { invoiceF, factor, invoiceId } = await invoiceCreatedFixture();
      const advance = ethers.parseUnits("50000", 6);
      await expect(invoiceF.connect(factor).financeInvoice(invoiceId, advance, 500))
        .to.emit(invoiceF, "InvoiceFinanced");
      const inv = await invoiceF.getInvoice(invoiceId);
      expect(inv.status).to.equal(1); // PARTIALLY_FINANCED
    });

    it("should fully finance an invoice", async function () {
      const { invoiceF, factor, invoiceId } = await invoiceCreatedFixture();
      await invoiceF.connect(factor).financeInvoice(invoiceId, FACE_VALUE, 500);
      const inv = await invoiceF.getInvoice(invoiceId);
      expect(inv.status).to.equal(2); // FULLY_FINANCED
    });

    it("should revert exceeding face value", async function () {
      const { invoiceF, factor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(factor).financeInvoice(invoiceId, FACE_VALUE + 1n, 500))
        .to.be.revertedWithCustomError(invoiceF, "ExceedsFaceValue");
    });

    it("should revert excessive discount rate", async function () {
      const { invoiceF, factor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(factor).financeInvoice(invoiceId, FACE_VALUE, 5001))
        .to.be.revertedWithCustomError(invoiceF, "InvalidDiscountRate");
    });
  });

  describe("Settlement", function () {
    it("should repay and settle invoice", async function () {
      const { invoiceF, debtor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(debtor).repayInvoice(invoiceId, FACE_VALUE))
        .to.emit(invoiceF, "InvoiceSettled");
    });

    it("should distribute to factors on repayment", async function () {
      const { invoiceF, usdc, debtor, factor, invoiceId } = await financedFixture();
      const factorBalBefore = await usdc.balanceOf(factor.address);
      await invoiceF.connect(debtor).repayInvoice(invoiceId, FACE_VALUE);
      const factorBalAfter = await usdc.balanceOf(factor.address);
      expect(factorBalAfter).to.be.gt(factorBalBefore);
    });

    it("should revert repay by non-debtor", async function () {
      const { invoiceF, creditor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(creditor).repayInvoice(invoiceId, FACE_VALUE))
        .to.be.revertedWithCustomError(invoiceF, "NotDebtor");
    });
  });

  describe("Overdue", function () {
    it("should mark invoice overdue after maturity + grace", async function () {
      const { invoiceF, other, invoiceId, maturity } = await invoiceCreatedFixture();
      // maturity + 7 day grace + 1
      await time.increaseTo(maturity + 86400n * 7n + 1n);
      await expect(invoiceF.connect(other).markOverdue(invoiceId))
        .to.emit(invoiceF, "InvoiceMarkedOverdue");
    });

    it("should revert if not yet overdue", async function () {
      const { invoiceF, other, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(other).markOverdue(invoiceId))
        .to.be.revertedWithCustomError(invoiceF, "InvoiceNotOverdue");
    });
  });

  describe("Disputes", function () {
    it("should initiate a dispute", async function () {
      const { invoiceF, creditor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(creditor).initiateDispute(invoiceId, "goods not delivered"))
        .to.emit(invoiceF, "DisputeInitiated");
      const inv = await invoiceF.getInvoice(invoiceId);
      expect(inv.status).to.equal(5); // DISPUTED
    });

    it("should resolve a dispute", async function () {
      const { invoiceF, usdc, creditor, arbiter, invoiceId } = await invoiceCreatedFixture();
      // Fund the contract with some tokens for awards
      await usdc.mint(invoiceF.target, FACE_VALUE);
      const tx = await invoiceF.connect(creditor).initiateDispute(invoiceId, "issue");
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      const disputeId = event.args[0];

      const creditorAward = ethers.parseUnits("80000", 6);
      const debtorRefund = ethers.parseUnits("20000", 6);
      await expect(invoiceF.connect(arbiter).resolveDispute(disputeId, 1, creditorAward, debtorRefund))
        .to.emit(invoiceF, "DisputeResolved");
    });

    it("should revert duplicate dispute", async function () {
      const { invoiceF, creditor, invoiceId } = await invoiceCreatedFixture();
      await invoiceF.connect(creditor).initiateDispute(invoiceId, "issue");
      await expect(invoiceF.connect(creditor).initiateDispute(invoiceId, "issue2"))
        .to.be.revertedWithCustomError(invoiceF, "DisputeAlreadyActive");
    });

    it("should revert dispute by non-party", async function () {
      const { invoiceF, other, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(other).initiateDispute(invoiceId, "issue"))
        .to.be.revertedWithCustomError(invoiceF, "NotInvoiceParty");
    });
  });

  describe("Collateral", function () {
    it("should deposit collateral", async function () {
      const { invoiceF, usdc, debtor, invoiceId } = await invoiceCreatedFixture();
      const amt = ethers.parseUnits("10000", 6);
      await expect(invoiceF.connect(debtor).depositCollateral(invoiceId, usdc.target, amt))
        .to.emit(invoiceF, "CollateralDeposited");
    });

    it("should release collateral after settlement", async function () {
      const { invoiceF, usdc, debtor, invoiceId } = await invoiceCreatedFixture();
      const amt = ethers.parseUnits("10000", 6);
      await invoiceF.connect(debtor).depositCollateral(invoiceId, usdc.target, amt);
      // Settle the invoice
      await invoiceF.connect(debtor).repayInvoice(invoiceId, FACE_VALUE);
      await expect(invoiceF.connect(debtor).releaseCollateral(invoiceId, debtor.address))
        .to.emit(invoiceF, "CollateralReleased");
    });
  });

  describe("Credit Scoring", function () {
    it("should adjust credit score", async function () {
      const { invoiceF, analyst, creditor } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(analyst).adjustCreditScore(creditor.address, 700))
        .to.emit(invoiceF, "CreditScoreUpdated");
      const cp = await invoiceF.getCreditProfile(creditor.address);
      expect(cp.creditScore).to.equal(700);
    });

    it("should revert invalid score", async function () {
      const { invoiceF, analyst, creditor } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(analyst).adjustCreditScore(creditor.address, 299))
        .to.be.revertedWithCustomError(invoiceF, "InvalidCreditScore");
      await expect(invoiceF.connect(analyst).adjustCreditScore(creditor.address, 851))
        .to.be.revertedWithCustomError(invoiceF, "InvalidCreditScore");
    });

    it("should return suggested discount rate", async function () {
      const { invoiceF, other } = await loadFixture(deployFixture);
      expect(await invoiceF.getSuggestedDiscountRate(other.address)).to.equal(1500); // unknown
    });
  });

  describe("Cancel", function () {
    it("should cancel an unfunded invoice", async function () {
      const { invoiceF, creditor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(creditor).cancelInvoice(invoiceId))
        .to.emit(invoiceF, "InvoiceCancelled");
    });

    it("should revert cancel by non-creditor", async function () {
      const { invoiceF, debtor, invoiceId } = await invoiceCreatedFixture();
      await expect(invoiceF.connect(debtor).cancelInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoiceF, "NotCreditor");
    });

    it("should revert cancel of financed invoice", async function () {
      const { invoiceF, creditor, invoiceId } = await financedFixture();
      await expect(invoiceF.connect(creditor).cancelInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoiceF, "InvalidInvoiceStatus");
    });
  });

  describe("Batch Creation", function () {
    it("should batch create invoices", async function () {
      const { invoiceF, usdc, creditor, debtor, other } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const fv = ethers.parseUnits("50000", 6);
      await expect(invoiceF.connect(creditor).batchCreateInvoices(
        [debtor.address, other.address], [fv, fv], usdc.target, [maturity, maturity],
        [DOC_HASH, DOC_HASH], 0, 0
      )).to.emit(invoiceF, "InvoiceBatchCreated");
    });

    it("should revert batch too large", async function () {
      const { invoiceF, usdc, creditor, debtor } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const arr51 = Array(51).fill(debtor.address);
      const vals51 = Array(51).fill(FACE_VALUE);
      const mats51 = Array(51).fill(maturity);
      const hashes51 = Array(51).fill(DOC_HASH);
      await expect(invoiceF.connect(creditor).batchCreateInvoices(
        arr51, vals51, usdc.target, mats51, hashes51, 0, 0
      )).to.be.revertedWithCustomError(invoiceF, "BatchTooLarge");
    });
  });

  describe("Admin", function () {
    it("should set supported token", async function () {
      const { invoiceF, admin, other } = await loadFixture(deployFixture);
      await expect(invoiceF.connect(admin).setSupportedToken(other.address, true))
        .to.emit(invoiceF, "TokenSupported");
    });

    it("should set protocol fee", async function () {
      const { invoiceF, admin } = await loadFixture(deployFixture);
      await expect(invoiceF.connect(admin).setProtocolFee(200))
        .to.emit(invoiceF, "ProtocolFeeUpdated");
    });

    it("should set business registry", async function () {
      const { invoiceF, admin, other } = await loadFixture(deployFixture);
      await expect(invoiceF.connect(admin).setBusinessRegistry(other.address))
        .to.emit(invoiceF, "BusinessRegistryUpdated");
    });

    it("should pause and unpause", async function () {
      const { invoiceF, admin } = await loadFixture(deployFixture);
      await invoiceF.connect(admin).pause();
      expect(await invoiceF.paused()).to.be.true;
      await invoiceF.connect(admin).unpause();
    });
  });
});
