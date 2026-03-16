const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ================================================================
// PaymentChannels - HTLC branch coverage
// ================================================================
describe("PaymentChannels - HTLC Coverage", function () {
  async function deployFixture() {
    const [admin, partyA, partyB, other, treasury] = await ethers.getSigners();
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

    return { pc, usdc, admin, partyA, partyB, other, treasury };
  }

  const DEPOSIT = ethers.parseUnits("10000", 6);
  const CHALLENGE_PERIOD = 3600;

  async function activeChannelFixture() {
    const fixture = await loadFixture(deployFixture);
    const { pc, usdc, partyA, partyB } = fixture;
    const tx = await pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
    const channelId = event.args[0];
    // Fund channel by partyB to make it ACTIVE
    await pc.connect(partyB).fundChannel(channelId, DEPOSIT);
    return { ...fixture, channelId };
  }

  describe("Create HTLC", function () {
    it("should create an HTLC by partyA", async function () {
      const { pc, partyA, channelId } = await activeChannelFixture();
      const secret = ethers.keccak256(ethers.toUtf8Bytes("secret"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
      const timelock = BigInt(await time.latest()) + 7200n;
      await expect(pc.connect(partyA).createHTLC(channelId, DEPOSIT / 10n, hashLock, timelock))
        .to.emit(pc, "HTLCCreated");
    });

    it("should create an HTLC by partyB (covers balanceB branch)", async function () {
      const { pc, partyB, channelId } = await activeChannelFixture();
      const secret = ethers.keccak256(ethers.toUtf8Bytes("secret2"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
      const timelock = BigInt(await time.latest()) + 7200n;
      await expect(pc.connect(partyB).createHTLC(channelId, DEPOSIT / 10n, hashLock, timelock))
        .to.emit(pc, "HTLCCreated");
    });
  });

  describe("Claim HTLC", function () {
    it("should claim HTLC (receiver is partyB)", async function () {
      const { pc, partyA, partyB, channelId } = await activeChannelFixture();
      const secret = ethers.keccak256(ethers.toUtf8Bytes("claimsecret"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const tx = await pc.connect(partyA).createHTLC(channelId, DEPOSIT / 10n, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      // Receiver (partyB) claims with preimage
      await expect(pc.connect(partyB).claimHTLC(htlcId, secret))
        .to.emit(pc, "HTLCClaimed");
    });

    it("should claim HTLC (receiver is partyA - created by partyB)", async function () {
      const { pc, partyA, partyB, channelId } = await activeChannelFixture();
      const secret = ethers.keccak256(ethers.toUtf8Bytes("claimsecretB"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const tx = await pc.connect(partyB).createHTLC(channelId, DEPOSIT / 10n, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      // Receiver (partyA) claims
      await expect(pc.connect(partyA).claimHTLC(htlcId, secret))
        .to.emit(pc, "HTLCClaimed");
    });
  });

  describe("Refund HTLC", function () {
    it("should refund expired HTLC (sender is partyA)", async function () {
      const { pc, partyA, channelId } = await activeChannelFixture();
      const secret = ethers.keccak256(ethers.toUtf8Bytes("refundsecret"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
      const timelock = BigInt(await time.latest()) + 3601n;
      const tx = await pc.connect(partyA).createHTLC(channelId, DEPOSIT / 10n, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      // Wait for timelock expiry
      await time.increase(3602);
      await expect(pc.refundHTLC(htlcId))
        .to.emit(pc, "HTLCRefunded");
    });

    it("should refund expired HTLC (sender is partyB)", async function () {
      const { pc, partyB, channelId } = await activeChannelFixture();
      const secret = ethers.keccak256(ethers.toUtf8Bytes("refundsecretB"));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [secret]));
      const timelock = BigInt(await time.latest()) + 3601n;
      const tx = await pc.connect(partyB).createHTLC(channelId, DEPOSIT / 10n, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      await time.increase(3602);
      await expect(pc.refundHTLC(htlcId))
        .to.emit(pc, "HTLCRefunded");
    });
  });

  describe("Cooperative Close", function () {
    it("should cooperatively close a channel", async function () {
      const { pc, partyA, partyB, channelId } = await activeChannelFixture();
      const finalBalA = DEPOSIT;
      const finalBalB = DEPOSIT;
      const nonce = 1;
      // Both parties agree - compute state hash
      const stateHash = ethers.keccak256(
        ethers.solidityPacked(
          ["bytes32", "uint256", "uint256", "uint256", "string"],
          [channelId, finalBalA, finalBalB, nonce, "CLOSE"]
        )
      );
      const sigA = await partyA.signMessage(ethers.getBytes(stateHash));
      const sigB = await partyB.signMessage(ethers.getBytes(stateHash));

      await expect(pc.connect(partyA).cooperativeClose(
        channelId, finalBalA, finalBalB, nonce, sigA, sigB
      )).to.emit(pc, "ChannelCooperativeClose");
    });
  });
});

// ================================================================
// LiquidityPool - repayFlashLoan and more branches
// ================================================================
describe("LiquidityPool - Flash Loan Repay Coverage", function () {
  async function deployFixture() {
    const [admin, provider, borrower, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenA = await MockERC20.deploy("TokenA", "TKA", 18);
    const tokenB = await MockERC20.deploy("TokenB", "TKB", 18);

    let token0, token1;
    if (BigInt(tokenA.target) < BigInt(tokenB.target)) {
      token0 = tokenA; token1 = tokenB;
    } else {
      token0 = tokenB; token1 = tokenA;
    }

    const LP = await ethers.getContractFactory("LiquidityPool");
    const pool = await LP.deploy(admin.address, treasuryAddr.address);

    const LP_ROLE = await pool.LIQUIDITY_PROVIDER_ROLE();
    await pool.connect(admin).grantRole(LP_ROLE, provider.address);

    const poolTx = await pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 8000);
    const poolReceipt = await poolTx.wait();
    const poolEvent = poolReceipt.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
    const poolId = poolEvent.args[0];

    const mintAmount = ethers.parseEther("10000000");
    await token0.mint(provider.address, mintAmount);
    await token1.mint(provider.address, mintAmount);
    await token0.connect(provider).approve(pool.target, ethers.MaxUint256);
    await token1.connect(provider).approve(pool.target, ethers.MaxUint256);

    // Add liquidity
    await pool.connect(provider).addLiquidity(poolId, ethers.parseEther("10000"), ethers.parseEther("10000"), -1000, 1000);

    // Mint for borrower
    await token0.mint(borrower.address, mintAmount);
    await token1.mint(borrower.address, mintAmount);
    await token0.connect(borrower).approve(pool.target, ethers.MaxUint256);
    await token1.connect(borrower).approve(pool.target, ethers.MaxUint256);

    return { pool, token0, token1, admin, provider, borrower, treasuryAddr, poolId };
  }

  it("should revert flash loan when pool doesn't exist", async function () {
    const { pool, token0, borrower } = await loadFixture(deployFixture);
    await expect(pool.connect(borrower).flashLoan(ethers.ZeroHash, token0.target, 100, "0x"))
      .to.be.reverted;
  });

  it("should revert addLiquidity with zero amounts", async function () {
    const { pool, provider, poolId } = await loadFixture(deployFixture);
    await expect(pool.connect(provider).addLiquidity(poolId, 0, 0, -1000, 1000))
      .to.be.revertedWithCustomError(pool, "ZeroAmount");
  });
});

// ================================================================
// InvoiceFinancing - more branch coverage for _distributePayment and _updateCreditScore
// ================================================================
describe("InvoiceFinancing - Branch Coverage Push", function () {
  async function deployFixture() {
    const [admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const IF = await ethers.getContractFactory("InvoiceFinancing");
    const invoicing = await IF.deploy(admin.address, treasuryAddr.address, 100);

    const FACTOR_ROLE = await invoicing.FACTOR_ROLE();
    const ARBITER_ROLE = await invoicing.ARBITER_ROLE();
    await invoicing.connect(admin).grantRole(FACTOR_ROLE, factor.address);
    await invoicing.connect(admin).grantRole(ARBITER_ROLE, arbiter.address);
    await invoicing.connect(admin).setSupportedToken(token.target, true);

    const mintAmount = ethers.parseUnits("100000000000", 6);
    await token.mint(creditor.address, mintAmount);
    await token.mint(debtor.address, mintAmount);
    await token.mint(factor.address, mintAmount);
    await token.connect(creditor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(debtor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(factor).approve(invoicing.target, ethers.MaxUint256);

    return { invoicing, token, admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr };
  }

  it("should repay a financed invoice with pro-rata distribution to factor", async function () {
    const { invoicing, factor, debtor, creditor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("financed-inv"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    // Finance the full invoice
    await invoicing.connect(factor).financeInvoice(invoiceId, faceValue, 300);

    // Repay the full invoice as debtor
    await expect(invoicing.connect(debtor).repayInvoice(invoiceId, faceValue))
      .to.emit(invoicing, "InvoiceSettled");
  });

  it("should handle invoice with excessive discount (expected return capped)", async function () {
    const { invoicing, factor, creditor, debtor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("cap-inv"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    // High discount rate to potentially cap expectedReturn
    await invoicing.connect(factor).financeInvoice(invoiceId, faceValue, 5000);
  });

  it("should revert finance of cancelled invoice", async function () {
    const { invoicing, factor, creditor, debtor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("cancel-inv"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    await invoicing.connect(creditor).cancelInvoice(invoiceId);

    await expect(invoicing.connect(factor).financeInvoice(invoiceId, faceValue, 300))
      .to.be.revertedWithCustomError(invoicing, "InvalidInvoiceStatus");
  });

  it("should revert dispute on already disputed invoice", async function () {
    const { invoicing, creditor, debtor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("double-dispute"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    await invoicing.connect(debtor).initiateDispute(invoiceId, "first dispute");
    await expect(invoicing.connect(creditor).initiateDispute(invoiceId, "second dispute"))
      .to.be.revertedWithCustomError(invoicing, "DisputeAlreadyActive");
  });

  it("should revert cancel on non-CREATED invoice", async function () {
    const { invoicing, factor, creditor, debtor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("financed-cancel"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    // Finance changes status to PARTIALLY_FINANCED
    await invoicing.connect(factor).financeInvoice(invoiceId, faceValue / 2n, 300);

    await expect(invoicing.connect(creditor).cancelInvoice(invoiceId))
      .to.be.revertedWithCustomError(invoicing, "InvalidInvoiceStatus");
  });

  it("should revert dispute by non-party", async function () {
    const { invoicing, other, creditor, debtor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("non-party-dispute"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    await expect(invoicing.connect(other).initiateDispute(invoiceId, "not party"))
      .to.be.revertedWithCustomError(invoicing, "NotInvoiceParty");
  });

  it("should revert invalid discount rate", async function () {
    const { invoicing, factor, creditor, debtor, token } = await loadFixture(deployFixture);
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("bad-discount"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];

    const MAX_DISCOUNT = await invoicing.MAX_DISCOUNT_BPS();
    await expect(invoicing.connect(factor).financeInvoice(invoiceId, faceValue, MAX_DISCOUNT + 1n))
      .to.be.revertedWithCustomError(invoicing, "InvalidDiscountRate");
  });

  it("should revert invalid grace period", async function () {
    const { invoicing, creditor, debtor, token } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const MAX_GRACE = await invoicing.MAX_GRACE_PERIOD();
    await expect(invoicing.connect(creditor).createInvoice(
      debtor.address, ethers.parseUnits("100000", 6), token.target, maturity, ethers.ZeroHash, Number(MAX_GRACE) + 1, 200
    )).to.be.revertedWithCustomError(invoicing, "InvalidGracePeriod");
  });

  it("should revert invalid penalty rate", async function () {
    const { invoicing, creditor, debtor, token } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const MAX_PENALTY = await invoicing.MAX_LATE_PENALTY_BPS();
    await expect(invoicing.connect(creditor).createInvoice(
      debtor.address, ethers.parseUnits("100000", 6), token.target, maturity, ethers.ZeroHash, 7, Number(MAX_PENALTY) + 1
    )).to.be.revertedWithCustomError(invoicing, "InvalidPenaltyRate");
  });
});

// ================================================================
// FXHedgingVault - option and MtM branches
// ================================================================
describe("FXHedgingVault - Option & MtM Coverage", function () {
  async function deployFixture() {
    const [admin, hedger, oracle, riskManager, liquidator, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const collateral = await MockERC20.deploy("USDC", "USDC", 6);

    const FXV = await ethers.getContractFactory("FXHedgingVault");
    const vault = await FXV.deploy(admin.address, treasuryAddr.address, 100);

    const ORACLE_ROLE = await vault.ORACLE_ROLE();
    const RISK_MANAGER_ROLE = await vault.RISK_MANAGER_ROLE();
    const LIQUIDATOR_ROLE = await vault.LIQUIDATOR_ROLE();
    await vault.connect(admin).grantRole(ORACLE_ROLE, oracle.address);
    await vault.connect(admin).grantRole(RISK_MANAGER_ROLE, riskManager.address);
    await vault.connect(admin).grantRole(LIQUIDATOR_ROLE, liquidator.address);
    await vault.connect(admin).setSupportedCollateral(collateral.target, true);

    const pairTx = await vault.connect(admin).addCurrencyPair(
      "0x555344", "0x455552", 10000, 1000, 500
    );
    const pairReceipt = await pairTx.wait();
    const pairEvent = pairReceipt.logs.find(l => l.fragment && l.fragment.name === "CurrencyPairAdded");
    const pairId = pairEvent.args[0];

    await vault.connect(oracle).submitFXRate(pairId, 367250000n);

    const mintAmount = ethers.parseUnits("100000000", 6);
    await collateral.mint(hedger.address, mintAmount);
    await collateral.connect(hedger).approve(vault.target, ethers.MaxUint256);

    return { vault, collateral, admin, hedger, oracle, riskManager, liquidator, other, treasuryAddr, pairId };
  }

  it("should assess hedge effectiveness", async function () {
    const { vault, collateral, hedger, oracle, riskManager, pairId } = await loadFixture(deployFixture);
    const notional = ethers.parseUnits("100000", 6);
    const coll = ethers.parseUnits("15000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const tx = await vault.connect(hedger).createForward(pairId, notional, maturity, collateral.target, coll);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
    const positionId = event.args[0];

    await vault.connect(riskManager).assessHedgeEffectiveness(positionId, ethers.parseUnits("1000", 6));
  });

  it("should revert createForward with non-existent pair", async function () {
    const { vault, collateral, hedger } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    await expect(vault.connect(hedger).createForward(
      ethers.ZeroHash, ethers.parseUnits("1000", 6), maturity, collateral.target, ethers.parseUnits("200", 6)
    )).to.be.revertedWithCustomError(vault, "PairNotFound");
  });
});

// ================================================================
// CrossChainRouter - more branch coverage
// ================================================================
describe("CrossChainRouter - Branch Push", function () {
  async function deployFixture() {
    const [admin, relay1, sender, recipient, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const CCR = await ethers.getContractFactory("CrossChainRouter");
    const router = await CCR.deploy(admin.address, treasuryAddr.address);

    await router.connect(admin).setTokenSupport(token.target, true);
    await router.connect(admin).addChain(
      1, "Ethereum", ethers.parseUnits("1", 6), 50, 12, 86400,
      ethers.parseUnits("10", 6), ethers.parseUnits("1000000", 6)
    );

    const mintAmount = ethers.parseUnits("10000000", 6);
    await token.mint(sender.address, mintAmount);
    await token.connect(sender).approve(router.target, ethers.MaxUint256);

    return { router, token, admin, relay1, sender, recipient, other, treasuryAddr };
  }

  it("should initiate a cross-chain transfer", async function () {
    const { router, token, sender } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("1000", 6);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await expect(router.connect(sender).initiateTransfer(
      token.target, amount, 1, recipientHash
    )).to.emit(router, "TransferInitiated");
  });

  it("should revert transfer to unsupported chain", async function () {
    const { router, token, sender } = await loadFixture(deployFixture);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await expect(router.connect(sender).initiateTransfer(
      token.target, ethers.parseUnits("100", 6), 999, recipientHash
    )).to.be.revertedWithCustomError(router, "UnsupportedChain");
  });

  it("should revert transfer below minimum", async function () {
    const { router, token, sender } = await loadFixture(deployFixture);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await expect(router.connect(sender).initiateTransfer(
      token.target, 1, 1, recipientHash
    )).to.be.revertedWithCustomError(router, "AmountBelowMinimum");
  });

  it("should revert transfer above maximum", async function () {
    const { router, token, sender } = await loadFixture(deployFixture);
    const tooMuch = ethers.parseUnits("2000000", 6);
    await token.mint(sender.address, tooMuch);
    await token.connect(sender).approve(router.target, tooMuch);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await expect(router.connect(sender).initiateTransfer(
      token.target, tooMuch, 1, recipientHash
    )).to.be.revertedWithCustomError(router, "AmountAboveMaximum");
  });

  it("should revert transfer with unsupported token", async function () {
    const { router, sender, other } = await loadFixture(deployFixture);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await expect(router.connect(sender).initiateTransfer(
      other.address, ethers.parseUnits("100", 6), 1, recipientHash
    )).to.be.revertedWithCustomError(router, "UnsupportedToken");
  });
});

// ================================================================
// NoblePay - additional branch coverage
// ================================================================
describe("NoblePay - Branch Push", function () {
  async function deployFixture() {
    const [admin, treasury, teeNode, complianceOfficer, business1, recipient, other] = await ethers.getSigners();
    const NP = await ethers.getContractFactory("NoblePay");
    const baseFee = ethers.parseUnits("1", 6);
    const noblepay = await NP.deploy(admin.address, treasury.address, baseFee, 50);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const TEE_NODE_ROLE = await noblepay.TEE_NODE_ROLE();
    const COMPLIANCE_OFFICER_ROLE = await noblepay.COMPLIANCE_OFFICER_ROLE();
    await noblepay.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await noblepay.connect(admin).grantRole(COMPLIANCE_OFFICER_ROLE, complianceOfficer.address);
    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true);

    const amount = ethers.parseUnits("100000000", 6);
    await usdc.mint(business1.address, amount);
    await usdc.connect(business1).approve(noblepay.target, amount);

    return { noblepay, usdc, admin, treasury, teeNode, complianceOfficer, business1, recipient, other };
  }

  it("should revert payment with unsupported token", async function () {
    const { noblepay, business1, recipient, other } = await loadFixture(deployFixture);
    await expect(noblepay.connect(business1).initiatePayment(
      recipient.address, 1000, other.address, ethers.ZeroHash, "0x555344"
    )).to.be.revertedWithCustomError(noblepay, "UnsupportedToken");
  });

  it("should revert payment by unregistered business", async function () {
    const { noblepay, usdc, other, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("100", 6);
    await usdc.mint(other.address, amount);
    await usdc.connect(other).approve(noblepay.target, amount);
    await expect(noblepay.connect(other).initiatePayment(
      recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
    )).to.be.revertedWithCustomError(noblepay, "NotRegisteredBusiness");
  });

  it("should revert payment to zero address", async function () {
    const { noblepay, usdc, business1 } = await loadFixture(deployFixture);
    await expect(noblepay.connect(business1).initiatePayment(
      ethers.ZeroAddress, 1000, usdc.target, ethers.ZeroHash, "0x555344"
    )).to.be.revertedWithCustomError(noblepay, "ZeroAddress");
  });

  it("should revert payment with zero amount", async function () {
    const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
    await expect(noblepay.connect(business1).initiatePayment(
      recipient.address, 0, usdc.target, ethers.ZeroHash, "0x555344"
    )).to.be.revertedWithCustomError(noblepay, "ZeroAmount");
  });

  it("should revert refund of non-refundable payment", async function () {
    const { noblepay, usdc, teeNode, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("100", 6);
    const tx = await noblepay.connect(business1).initiatePayment(
      recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
    const paymentId = event.args[0];

    // Approve the payment
    await noblepay.connect(teeNode).submitComplianceResult(
      paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
    );
    // Settle it
    await noblepay.settlePayment(paymentId);

    // Try to refund settled payment
    await expect(noblepay.refundPayment(paymentId))
      .to.be.revertedWith("NoblePay: cannot refund this payment");
  });

  it("should settle payment with percentage fee only (no base fee)", async function () {
    const { noblepay, usdc, admin, teeNode, business1, recipient } = await loadFixture(deployFixture);
    // Set base fee to 0 but keep percentage fee
    await noblepay.connect(admin).setFees(0, 100);

    const amount = ethers.parseUnits("100", 6);
    const tx = await noblepay.connect(business1).initiatePayment(
      recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
    const paymentId = event.args[0];

    await noblepay.connect(teeNode).submitComplianceResult(
      paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
    );

    await expect(noblepay.settlePayment(paymentId))
      .to.emit(noblepay, "PaymentSettled");
  });
});

// ================================================================
// StreamingPayments - partial withdraw, pause edge cases
// ================================================================
describe("StreamingPayments - Branch Push", function () {
  async function deployFixture() {
    const [admin, sender, recipient, other] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);
    const SP = await ethers.getContractFactory("StreamingPayments");
    const sp = await SP.deploy(admin.address);

    const mintAmount = ethers.parseUnits("100000000", 6);
    await token.mint(sender.address, mintAmount);
    await token.connect(sender).approve(sp.target, ethers.MaxUint256);

    return { sp, token, admin, sender, recipient, other };
  }

  it("should do partial withdrawal mid-stream", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    const duration = 86400;
    const tx = await sp.connect(sender).createStream(recipient.address, token.target, amount, duration, 0);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];

    // Advance half the duration
    await time.increase(duration / 2);
    await sp.connect(recipient).withdraw(streamId);

    // Check partial withdrawal
    const stream = await sp.getStream(streamId);
    expect(stream.withdrawnAmount).to.be.greaterThan(0);
  });

  it("should revert withdraw by non-recipient", async function () {
    const { sp, token, sender, recipient, other } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    const tx = await sp.connect(sender).createStream(recipient.address, token.target, amount, 86400, 0);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];

    await time.increase(3600);
    await expect(sp.connect(other).withdraw(streamId))
      .to.be.revertedWithCustomError(sp, "Unauthorized");
  });

  it("should revert creating stream to self", async function () {
    const { sp, token, sender } = await loadFixture(deployFixture);
    await expect(sp.connect(sender).createStream(sender.address, token.target, 1000, 86400, 0))
      .to.be.revertedWithCustomError(sp, "InvalidRecipient");
  });

  it("should revert creating stream with duration too short", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    await expect(sp.connect(sender).createStream(recipient.address, token.target, 1000, 60, 0))
      .to.be.revertedWithCustomError(sp, "InvalidDuration");
  });
});

// ================================================================
// BusinessRegistry - more branch coverage
// ================================================================
describe("BusinessRegistry - Branch Push", function () {
  async function deployFixture() {
    const [admin, verifier, biz1, officer1, other] = await ethers.getSigners();
    const BR = await ethers.getContractFactory("BusinessRegistry");
    const br = await BR.deploy(admin.address);
    const VERIFIER_ROLE = await br.VERIFIER_ROLE();
    await br.connect(admin).grantRole(VERIFIER_ROLE, verifier.address);
    return { br, admin, verifier, biz1, officer1, other };
  }

  it("should register and verify a business", async function () {
    const { br, verifier, biz1, officer1 } = await loadFixture(deployFixture);
    await br.connect(biz1).registerBusiness("LIC001", "Test Corp", 0, officer1.address);
    await expect(br.connect(verifier).verifyBusiness(biz1.address))
      .to.emit(br, "BusinessVerified");
  });

  it("should revert registration with zero address officer", async function () {
    const { br, biz1 } = await loadFixture(deployFixture);
    await expect(br.connect(biz1).registerBusiness("LIC002", "Test Corp", 0, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(br, "ZeroAddress");
  });

  it("should revert registration with empty license", async function () {
    const { br, biz1, officer1 } = await loadFixture(deployFixture);
    await expect(br.connect(biz1).registerBusiness("", "Test Corp", 0, officer1.address))
      .to.be.revertedWithCustomError(br, "InvalidLicenseNumber");
  });
});
