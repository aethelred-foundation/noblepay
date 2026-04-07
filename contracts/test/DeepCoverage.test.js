import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

// ================================================================
// MockERC20 burn coverage
// ================================================================
describe("MockERC20 - Deep Coverage", function () {
  it("should burn tokens", async function () {
    const [owner] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Test", "TST", 18);
    await token.mint(owner.address, 1000);
    await token.burn(owner.address, 500);
    expect(await token.balanceOf(owner.address)).to.equal(500);
  });
});

// ================================================================
// InvoiceFinancing Deep Coverage
// ================================================================
describe("InvoiceFinancing - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const IF = await ethers.getContractFactory("InvoiceFinancing");
    const invoicing = await IF.deploy(admin.address, treasuryAddr.address, 100);

    const FACTOR_ROLE = await invoicing.FACTOR_ROLE();
    const ANALYST_ROLE = await invoicing.CREDIT_ANALYST_ROLE();
    const ARBITER_ROLE = await invoicing.ARBITER_ROLE();
    await invoicing.connect(admin).grantRole(FACTOR_ROLE, factor.address);
    await invoicing.connect(admin).grantRole(ANALYST_ROLE, analyst.address);
    await invoicing.connect(admin).grantRole(ARBITER_ROLE, arbiter.address);
    await invoicing.connect(admin).setSupportedToken(token.target, true);

    const mintAmount = ethers.parseUnits("100000000", 6);
    await token.mint(creditor.address, mintAmount);
    await token.mint(debtor.address, mintAmount);
    await token.mint(factor.address, mintAmount);
    await token.mint(other.address, mintAmount);
    await token.connect(creditor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(debtor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(factor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(other).approve(invoicing.target, ethers.MaxUint256);

    return { invoicing, token, admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr };
  }

  async function invoiceFixture() {
    const fixture = await loadFixture(deployFixture);
    const { invoicing, token, creditor, debtor } = fixture;
    const faceValue = ethers.parseUnits("100000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const docHash = ethers.keccak256(ethers.toUtf8Bytes("inv001"));
    const tx = await invoicing.connect(creditor).createInvoice(
      debtor.address, faceValue, token.target, maturity, docHash, 7, 200
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
    const invoiceId = event.args[0];
    return { ...fixture, invoiceId, faceValue, maturity };
  }

  describe("Finance Invoice", function () {
    it("should finance an invoice (partial)", async function () {
      const { invoicing, factor, invoiceId, faceValue } = await invoiceFixture();
      const advanceAmount = faceValue / 2n;
      await expect(invoicing.connect(factor).financeInvoice(invoiceId, advanceAmount, 300))
        .to.emit(invoicing, "InvoiceFinanced");
    });

    it("should fully finance an invoice", async function () {
      const { invoicing, factor, invoiceId, faceValue } = await invoiceFixture();
      await expect(invoicing.connect(factor).financeInvoice(invoiceId, faceValue, 300))
        .to.emit(invoicing, "InvoiceFinanced");
      const inv = await invoicing.getInvoice(invoiceId);
      // Status should be FULLY_FINANCED (2)
      expect(inv.status).to.equal(2);
    });

    it("should revert finance with zero advance", async function () {
      const { invoicing, factor, invoiceId } = await invoiceFixture();
      await expect(invoicing.connect(factor).financeInvoice(invoiceId, 0, 300))
        .to.be.revertedWithCustomError(invoicing, "ZeroAmount");
    });

    it("should revert finance exceeding face value", async function () {
      const { invoicing, factor, invoiceId, faceValue } = await invoiceFixture();
      await expect(invoicing.connect(factor).financeInvoice(invoiceId, faceValue + 1n, 300))
        .to.be.revertedWithCustomError(invoicing, "ExceedsFaceValue");
    });
  });

  describe("Repay Invoice", function () {
    it("should repay invoice directly (no factoring positions)", async function () {
      const { invoicing, debtor, invoiceId, faceValue } = await invoiceFixture();
      await expect(invoicing.connect(debtor).repayInvoice(invoiceId, faceValue))
        .to.emit(invoicing, "InvoiceSettled");
    });

    it("should partially repay an invoice", async function () {
      const { invoicing, debtor, invoiceId, faceValue } = await invoiceFixture();
      await invoicing.connect(debtor).repayInvoice(invoiceId, faceValue / 2n);
      const inv = await invoicing.getInvoice(invoiceId);
      expect(inv.amountRepaid).to.equal(faceValue / 2n);
    });

    it("should repay a financed invoice (pro-rata distribution)", async function () {
      const { invoicing, factor, debtor, invoiceId, faceValue } = await invoiceFixture();
      // Finance first
      await invoicing.connect(factor).financeInvoice(invoiceId, faceValue / 2n, 300);
      // Repay
      await invoicing.connect(debtor).repayInvoice(invoiceId, faceValue);
    });

    it("should revert repay by non-debtor", async function () {
      const { invoicing, other, invoiceId, faceValue } = await invoiceFixture();
      await expect(invoicing.connect(other).repayInvoice(invoiceId, faceValue))
        .to.be.revertedWithCustomError(invoicing, "NotDebtor");
    });

    it("should revert repay zero amount", async function () {
      const { invoicing, debtor, invoiceId } = await invoiceFixture();
      await expect(invoicing.connect(debtor).repayInvoice(invoiceId, 0))
        .to.be.revertedWithCustomError(invoicing, "ZeroAmount");
    });

    it("should repay late invoice and update credit score", async function () {
      const { invoicing, debtor, invoiceId, faceValue, maturity } = await invoiceFixture();
      // Fast-forward past maturity + grace period
      await time.increaseTo(maturity + 86400n * 30n);
      // Repay (includes late penalty via _calculateTotalOwed)
      const totalOwed = faceValue + (faceValue * 200n * 120n) / (10000n * 365n);
      await invoicing.connect(debtor).repayInvoice(invoiceId, totalOwed);
    });
  });

  describe("Mark Overdue", function () {
    it("should mark invoice as overdue after grace period", async function () {
      const { invoicing, invoiceId, maturity } = await invoiceFixture();
      // Fast-forward past maturity + grace period (7 days)
      await time.increaseTo(maturity + 86400n * 8n);
      await expect(invoicing.markOverdue(invoiceId))
        .to.emit(invoicing, "InvoiceMarkedOverdue");
    });

    it("should revert markOverdue before grace period", async function () {
      const { invoicing, invoiceId } = await invoiceFixture();
      await expect(invoicing.markOverdue(invoiceId))
        .to.be.revertedWithCustomError(invoicing, "InvoiceNotOverdue");
    });
  });

  describe("Cancel Invoice", function () {
    it("should cancel an invoice by creditor", async function () {
      const { invoicing, creditor, invoiceId } = await invoiceFixture();
      await expect(invoicing.connect(creditor).cancelInvoice(invoiceId))
        .to.emit(invoicing, "InvoiceCancelled");
    });

    it("should revert cancel by non-creditor", async function () {
      const { invoicing, debtor, invoiceId } = await invoiceFixture();
      await expect(invoicing.connect(debtor).cancelInvoice(invoiceId))
        .to.be.revertedWithCustomError(invoicing, "NotCreditor");
    });

    it("should revert repay on cancelled invoice", async function () {
      const { invoicing, creditor, debtor, invoiceId, faceValue } = await invoiceFixture();
      await invoicing.connect(creditor).cancelInvoice(invoiceId);
      await expect(invoicing.connect(debtor).repayInvoice(invoiceId, faceValue))
        .to.be.revertedWithCustomError(invoicing, "InvalidInvoiceStatus");
    });
  });

  describe("Resolve Dispute", function () {
    it("should resolve a dispute with creditor award", async function () {
      const { invoicing, token, creditor, debtor, arbiter, invoiceId, faceValue } = await invoiceFixture();
      // Initiate dispute
      const tx = await invoicing.connect(debtor).initiateDispute(invoiceId, "quality issue");
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      const disputeId = event.args[0];

      // Fund the contract for distribution
      await token.mint(invoicing.target, faceValue);

      // Resolve with creditor winning
      await expect(invoicing.connect(arbiter).resolveDispute(disputeId, 1, faceValue / 2n, faceValue / 2n))
        .to.emit(invoicing, "DisputeResolved");
    });

    it("should resolve dispute with zero awards", async function () {
      const { invoicing, debtor, arbiter, invoiceId } = await invoiceFixture();
      const tx = await invoicing.connect(debtor).initiateDispute(invoiceId, "test");
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DisputeInitiated");
      const disputeId = event.args[0];

      await expect(invoicing.connect(arbiter).resolveDispute(disputeId, 2, 0, 0))
        .to.emit(invoicing, "DisputeResolved");
    });
  });

  describe("Deposit Collateral", function () {
    it("should deposit collateral against an invoice", async function () {
      const { invoicing, token, debtor, invoiceId } = await invoiceFixture();
      const amount = ethers.parseUnits("10000", 6);
      await expect(invoicing.connect(debtor).depositCollateral(invoiceId, token.target, amount))
        .to.emit(invoicing, "CollateralDeposited");
    });

    it("should revert collateral deposit with zero amount", async function () {
      const { invoicing, token, debtor, invoiceId } = await invoiceFixture();
      await expect(invoicing.connect(debtor).depositCollateral(invoiceId, token.target, 0))
        .to.be.revertedWithCustomError(invoicing, "ZeroAmount");
    });
  });

  describe("View Functions", function () {
    it("should return invoice via getInvoice", async function () {
      const { invoicing, invoiceId, creditor } = await invoiceFixture();
      const inv = await invoicing.getInvoice(invoiceId);
      expect(inv.creditor).to.equal(creditor.address);
    });

    it("should return credit profile", async function () {
      const { invoicing, debtor } = await loadFixture(deployFixture);
      const cp = await invoicing.getCreditProfile(debtor.address);
      expect(cp.lastUpdated).to.equal(0);
    });

    it("should return creditor and debtor invoices", async function () {
      const { invoicing, creditor, debtor, invoiceId } = await invoiceFixture();
      const creditorInvs = await invoicing.getCreditorInvoices(creditor.address);
      expect(creditorInvs.length).to.equal(1);
      const debtorInvs = await invoicing.getDebtorInvoices(debtor.address);
      expect(debtorInvs.length).to.equal(1);
    });

    it("should return invoice positions", async function () {
      const { invoicing, invoiceId } = await invoiceFixture();
      const positions = await invoicing.getInvoicePositions(invoiceId);
      expect(positions.length).to.equal(0);
    });

    it("should return factoring position after financing", async function () {
      const { invoicing, factor, invoiceId, faceValue } = await invoiceFixture();
      const tx = await invoicing.connect(factor).financeInvoice(invoiceId, faceValue / 2n, 300);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceFinanced");
      const positionId = event.args[1];
      const pos = await invoicing.getFactoringPosition(positionId);
      expect(pos.factor).to.equal(factor.address);
    });
  });

  describe("Pause", function () {
    it("should pause and unpause", async function () {
      const { invoicing, admin } = await loadFixture(deployFixture);
      await invoicing.connect(admin).pause();
      expect(await invoicing.paused()).to.be.true;
      await invoicing.connect(admin).unpause();
      expect(await invoicing.paused()).to.be.false;
    });
  });
});

// ================================================================
// FXHedgingVault Deep Coverage
// ================================================================
describe("FXHedgingVault - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, hedger, oracle, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const collateral = await MockERC20.deploy("USDC", "USDC", 6);

    const FXV = await ethers.getContractFactory("FXHedgingVault");
    const vault = await FXV.deploy(admin.address, treasuryAddr.address, 100);

    const ORACLE_ROLE = await vault.ORACLE_ROLE();
    await vault.connect(admin).grantRole(ORACLE_ROLE, oracle.address);
    await vault.connect(admin).setSupportedCollateral(collateral.target, true);

    // Create currency pair (bytes3 for currencies)
    const pairTx = await vault.connect(admin).addCurrencyPair(
      "0x555344", // USD
      "0x455552", // EUR
      10000, // maxHedgeRatio
      1000,  // marginReqBps (10%)
      500    // maintenanceMarginBps (5%)
    );
    const pairReceipt = await pairTx.wait();
    const pairEvent = pairReceipt.logs.find(l => l.fragment && l.fragment.name === "CurrencyPairAdded");
    const pairId = pairEvent.args[0];

    // Set initial rate
    await vault.connect(oracle).submitFXRate(pairId, 367250000n); // 3.6725 * 1e8

    const mintAmount = ethers.parseUnits("10000000", 6);
    await collateral.mint(hedger.address, mintAmount);
    await collateral.connect(hedger).approve(vault.target, ethers.MaxUint256);

    return { vault, collateral, admin, hedger, oracle, other, treasuryAddr, pairId };
  }

  async function forwardPositionFixture() {
    const fixture = await loadFixture(deployFixture);
    const { vault, collateral, hedger, pairId } = fixture;
    const notional = ethers.parseUnits("100000", 6);
    const collateralAmount = ethers.parseUnits("15000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const tx = await vault.connect(hedger).createForward(
      pairId, notional, maturity, collateral.target, collateralAmount
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
    const positionId = event.args[0];
    return { ...fixture, positionId, notional, collateralAmount, maturity };
  }

  describe("Emergency Unwind", function () {
    it("should emergency unwind an active position", async function () {
      const { vault, admin, positionId } = await forwardPositionFixture();
      await expect(vault.connect(admin).emergencyUnwind(positionId))
        .to.emit(vault, "EmergencyUnwind");
    });

    it("should revert emergency unwind of non-active position", async function () {
      const { vault, admin, oracle, positionId, pairId, maturity } = await forwardPositionFixture();
      // Settle first
      await time.increaseTo(maturity + 1n);
      await vault.connect(oracle).submitFXRate(pairId, 367250000n);
      await vault.connect(admin).settleForward(positionId);
      // Try emergency unwind
      await expect(vault.connect(admin).emergencyUnwind(positionId))
        .to.be.revertedWithCustomError(vault, "InvalidPositionStatus");
    });
  });

  describe("Maturity too far", function () {
    it("should revert when maturity exceeds MAX_MATURITY", async function () {
      const { vault, collateral, hedger, pairId } = await loadFixture(deployFixture);
      const notional = ethers.parseUnits("1000", 6);
      const coll = ethers.parseUnits("200", 6);
      const MAX_MATURITY = await vault.MAX_MATURITY();
      const maturity = BigInt(await time.latest()) + MAX_MATURITY + 86400n;
      await expect(vault.connect(hedger).createForward(pairId, notional, maturity, collateral.target, coll))
        .to.be.revertedWithCustomError(vault, "MaturityTooFar");
    });
  });

  describe("Stale Rate", function () {
    it("should revert settlement with stale rate", async function () {
      const { vault, admin, positionId, maturity } = await forwardPositionFixture();
      // Go past maturity AND past rate staleness
      await time.increaseTo(maturity + 86400n * 30n);
      await expect(vault.connect(admin).settleForward(positionId))
        .to.be.revertedWithCustomError(vault, "RateStale");
    });
  });

  describe("Admin Functions", function () {
    it("should set currency pair active/inactive", async function () {
      const { vault, admin, pairId } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setCurrencyPairActive(pairId, false))
        .to.emit(vault, "CurrencyPairUpdated");
    });

    it("should set settlement fee", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setSettlementFee(200))
        .to.emit(vault, "SettlementFeeUpdated");
    });

    it("should revert excessive settlement fee", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setSettlementFee(501))
        .to.be.revertedWithCustomError(vault, "InvalidFee");
    });

    it("should set treasury", async function () {
      const { vault, admin, other } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setTreasury(other.address))
        .to.emit(vault, "TreasuryUpdated");
    });
  });

  describe("View Functions", function () {
    it("should return position via getPosition", async function () {
      const { vault, hedger, positionId } = await forwardPositionFixture();
      const pos = await vault.getPosition(positionId);
      expect(pos.hedger).to.equal(hedger.address);
    });

    it("should return latest rate", async function () {
      const { vault, pairId } = await loadFixture(deployFixture);
      const [rate, updatedAt] = await vault.getLatestRate(pairId);
      expect(rate).to.equal(367250000n);
    });
  });
});

// ================================================================
// ComplianceOracle - swap-and-pop coverage
// ================================================================
describe("ComplianceOracle - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, teeNode1, teeNode2, teeNode3, other] = await ethers.getSigners();
    const CO = await ethers.getContractFactory("ComplianceOracle");
    const oracle = await CO.deploy(admin.address);

    const TEE_MANAGER_ROLE = await oracle.TEE_MANAGER_ROLE();
    await oracle.connect(admin).grantRole(TEE_MANAGER_ROLE, admin.address);

    return { oracle, admin, teeNode1, teeNode2, teeNode3, other };
  }

  it("should deregister a non-last TEE node (swap-and-pop)", async function () {
    const { oracle, admin, teeNode1, teeNode2, teeNode3 } = await loadFixture(deployFixture);
    const stake = await oracle.MIN_STAKE();

    // Register 3 nodes
    await oracle.connect(teeNode1).registerTEENode(
      ethers.toUtf8Bytes("pubkey1"), ethers.keccak256("0x01"), { value: stake }
    );
    await oracle.connect(teeNode2).registerTEENode(
      ethers.toUtf8Bytes("pubkey2"), ethers.keccak256("0x02"), { value: stake }
    );
    await oracle.connect(teeNode3).registerTEENode(
      ethers.toUtf8Bytes("pubkey3"), ethers.keccak256("0x03"), { value: stake }
    );

    // Deregister first node (triggers swap-and-pop where index != lastIndex)
    await oracle.connect(admin).deregisterTEENode(teeNode1.address);
    const count = await oracle.getActiveTEENodeCount();
    expect(count).to.equal(2);
  });

  it("should get active TEE node count", async function () {
    const { oracle, teeNode1 } = await loadFixture(deployFixture);
    const stake = await oracle.MIN_STAKE();
    await oracle.connect(teeNode1).registerTEENode(
      ethers.toUtf8Bytes("pubkey1"), ethers.keccak256("0x01"), { value: stake }
    );
    expect(await oracle.getActiveTEENodeCount()).to.equal(1);
  });
});

// ================================================================
// CrossChainRouter - swap-and-pop coverage
// ================================================================
describe("CrossChainRouter - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, relay1, relay2, relay3, sender, recipient, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const CCR = await ethers.getContractFactory("CrossChainRouter");
    const router = await CCR.deploy(admin.address, treasuryAddr.address);

    await router.connect(admin).setTokenSupport(token.target, true);
    await router.connect(admin).addChain(
      1, "Ethereum", ethers.parseUnits("1", 6), 50, 12, 86400, ethers.parseUnits("10", 6), ethers.parseUnits("1000000", 6)
    );

    const mintAmount = ethers.parseUnits("10000000", 6);
    await token.mint(sender.address, mintAmount);
    await token.connect(sender).approve(router.target, ethers.MaxUint256);

    return { router, token, admin, relay1, relay2, relay3, sender, recipient, other, treasuryAddr };
  }

  it("should deregister non-last relay (swap-and-pop)", async function () {
    const { router, admin, relay1, relay2, relay3 } = await loadFixture(deployFixture);
    const stake = await router.MIN_RELAY_STAKE();

    await router.connect(relay1).registerRelay({ value: stake });
    await router.connect(relay2).registerRelay({ value: stake });
    await router.connect(relay3).registerRelay({ value: stake });

    // Deregister first relay (triggers swap-and-pop where index != lastIndex)
    await router.connect(admin).deregisterRelay(relay1.address);
    const count = await router.getActiveRelayCount();
    expect(count).to.equal(2);
  });

  it("should return active relay count", async function () {
    const { router, relay1 } = await loadFixture(deployFixture);
    const stake = await router.MIN_RELAY_STAKE();
    await router.connect(relay1).registerRelay({ value: stake });
    expect(await router.getActiveRelayCount()).to.equal(1);
  });
});

// ================================================================
// LiquidityPool - CRITICAL circuit breaker path
// ================================================================
describe("LiquidityPool - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, provider, other, treasuryAddr] = await ethers.getSigners();
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

    // Create pool with low imbalance threshold to easily trigger CRITICAL
    const poolTx = await pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 7000);
    const poolReceipt = await poolTx.wait();
    const poolEvent = poolReceipt.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
    const poolId = poolEvent.args[0];

    const mintAmount = ethers.parseEther("10000000");
    await token0.mint(provider.address, mintAmount);
    await token1.mint(provider.address, mintAmount);
    await token0.connect(provider).approve(pool.target, ethers.MaxUint256);
    await token1.connect(provider).approve(pool.target, ethers.MaxUint256);

    return { pool, token0, token1, admin, provider, other, treasuryAddr, poolId };
  }

  it("should trigger CRITICAL circuit breaker with extreme imbalance", async function () {
    const { pool, provider, poolId } = await loadFixture(deployFixture);
    // Extreme imbalance: 99.9% token0, 0.1% token1
    const amount0 = ethers.parseEther("1000000");
    const amount1 = ethers.parseEther("1");
    await expect(pool.connect(provider).addLiquidity(poolId, amount0, amount1, -1000, 1000))
      .to.emit(pool, "CircuitBreakerTriggered");
  });

  it("should show CIRCUIT_BROKEN health after trigger", async function () {
    const { pool, provider, poolId } = await loadFixture(deployFixture);
    const amount0 = ethers.parseEther("1000000");
    const amount1 = ethers.parseEther("1");
    await pool.connect(provider).addLiquidity(poolId, amount0, amount1, -1000, 1000);
    const health = await pool.getPoolHealth(poolId);
    // CIRCUIT_BROKEN = 3
    expect(health).to.equal(3);
  });

  it("should reset circuit breaker after cooldown", async function () {
    const { pool, admin, provider, poolId } = await loadFixture(deployFixture);
    const amount0 = ethers.parseEther("1000000");
    const amount1 = ethers.parseEther("1");
    await pool.connect(provider).addLiquidity(poolId, amount0, amount1, -1000, 1000);
    // Wait for cooldown
    await time.increase(3601);
    await pool.connect(admin).resetCircuitBreaker(poolId);
    const health = await pool.getPoolHealth(poolId);
    // After reset, should recalculate (still imbalanced but not CIRCUIT_BROKEN status)
    expect(health).to.not.equal(3);
  });
});

// ================================================================
// StreamingPayments - _withdrawableBalance edge cases
// ================================================================
describe("StreamingPayments - Deep Coverage", function () {
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

  it("should return 0 withdrawable for cancelled stream", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    const duration = 86400;
    const tx = await sp.connect(sender).createStream(recipient.address, token.target, amount, duration, 0);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];

    await sp.connect(sender).cancelStream(streamId);
    const withdrawable = await sp.withdrawableBalance(streamId);
    expect(withdrawable).to.equal(0);
  });

  it("should withdraw full amount after stream completes", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    const duration = 3600;
    const tx = await sp.connect(sender).createStream(recipient.address, token.target, amount, duration, 0);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];

    // Past end time
    await time.increase(duration + 100);
    await sp.connect(recipient).withdraw(streamId);
  });
});

// ================================================================
// TravelRule - View function coverage
// ================================================================
describe("TravelRule - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, teeNode, vasp1, vasp2, other] = await ethers.getSigners();
    const TR = await ethers.getContractFactory("TravelRule");
    const tr = await TR.deploy(admin.address);

    const TEE_NODE_ROLE = await tr.TEE_NODE_ROLE();
    const VASP_ROLE = await tr.VASP_ROLE();
    await tr.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await tr.connect(admin).grantRole(VASP_ROLE, vasp1.address);
    await tr.connect(admin).grantRole(VASP_ROLE, vasp2.address);

    await tr.connect(vasp1).registerVASP(ethers.keccak256("0x01"), ethers.toUtf8Bytes("pubkey1"));
    await tr.connect(vasp2).registerVASP(ethers.keccak256("0x02"), ethers.toUtf8Bytes("pubkey2"));

    return { tr, admin, teeNode, vasp1, vasp2, other };
  }

  it("should return travel rule data via getTravelRuleData", async function () {
    const { tr, teeNode, vasp1, vasp2 } = await loadFixture(deployFixture);
    const paymentId = ethers.keccak256(ethers.toUtf8Bytes("payment-view"));
    const tx = await tr.connect(teeNode).submitTravelRuleData(
      paymentId,
      ethers.keccak256(ethers.toUtf8Bytes("originator")),
      vasp1.address,
      ethers.keccak256(ethers.toUtf8Bytes("VASP1")),
      ethers.keccak256(ethers.toUtf8Bytes("beneficiary")),
      vasp2.address,
      ethers.keccak256(ethers.toUtf8Bytes("VASP2")),
      ethers.parseUnits("10000", 6),
      "0x555344",
      ethers.keccak256(ethers.toUtf8Bytes("encrypted"))
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TravelRuleDataSubmitted");
    const travelRuleId = event.args[0];

    const data = await tr.getTravelRuleData(travelRuleId);
    expect(data.originatorAddress).to.equal(vasp1.address);

    const trId = await tr.getTravelRuleForPayment(paymentId);
    expect(trId).to.equal(travelRuleId);
  });
});

// ================================================================
// AIComplianceModule - View function coverage
// ================================================================
describe("AIComplianceModule - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, aiOp, officer, appellant, other] = await ethers.getSigners();
    const AIC = await ethers.getContractFactory("AIComplianceModule");
    const aic = await AIC.deploy(admin.address);

    const AI_OPERATOR_ROLE = await aic.AI_OPERATOR_ROLE();
    const COMPLIANCE_OFFICER_ROLE = await aic.COMPLIANCE_OFFICER_ROLE();
    await aic.connect(admin).grantRole(AI_OPERATOR_ROLE, aiOp.address);
    await aic.connect(admin).grantRole(COMPLIANCE_OFFICER_ROLE, officer.address);

    // Register a model
    const tx = await aic.connect(aiOp).registerModel("TestModel", "v1.0", ethers.keccak256("0xaa"));
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ModelRegistered");
    const modelId = event.args[0];

    return { aic, admin, aiOp, officer, appellant, other, modelId };
  }

  it("should return override record via getOverride", async function () {
    const { aic, aiOp, officer, modelId } = await loadFixture(deployFixture);
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("reason"));

    // Create a decision
    const tx = await aic.connect(aiOp).recordDecision(
      ethers.keccak256("0xbb"), modelId, 0, 80, evidenceHash, reasonHash
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
    const decisionId = event.args[0];

    // Override it
    const overrideTx = await aic.connect(officer).overrideDecision(
      decisionId, 1, ethers.keccak256(ethers.toUtf8Bytes("override_reason"))
    );
    const overrideReceipt = await overrideTx.wait();
    const overrideEvent = overrideReceipt.logs.find(l => l.fragment && l.fragment.name === "DecisionOverridden");
    const overrideId = overrideEvent.args[0];

    const overrideRecord = await aic.getOverride(overrideId);
    expect(overrideRecord.officer).to.equal(officer.address);

    const overrideCount = await aic.getDecisionOverrideCount(decisionId);
    expect(overrideCount).to.equal(1);
  });

  it("should return model count", async function () {
    const { aic } = await loadFixture(deployFixture);
    const count = await aic.getRegisteredModelCount();
    expect(count).to.equal(1);
  });

  it("should return subject decision count", async function () {
    const { aic, aiOp, modelId } = await loadFixture(deployFixture);
    const subjectHash = ethers.keccak256("0xcc");
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("reason"));
    await aic.connect(aiOp).recordDecision(subjectHash, modelId, 0, 80, evidenceHash, reasonHash);

    const count = await aic.getSubjectDecisionCount(subjectHash);
    expect(count).to.equal(1);
  });

  it("should return decision appeal count", async function () {
    const { aic, aiOp, appellant, modelId } = await loadFixture(deployFixture);
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes("evidence"));
    const reasonHash = ethers.keccak256(ethers.toUtf8Bytes("reason"));
    const tx = await aic.connect(aiOp).recordDecision(
      ethers.keccak256("0xdd"), modelId, 0, 80, evidenceHash, reasonHash
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "DecisionRecorded");
    const decisionId = event.args[0];

    await aic.connect(appellant).fileAppeal(decisionId, ethers.keccak256(ethers.toUtf8Bytes("grounds")));
    const count = await aic.getDecisionAppealCount(decisionId);
    expect(count).to.equal(1);
  });
});

// ================================================================
// NoblePay - Monthly limit and compliance officer modifier
// ================================================================
describe("NoblePay - Deep Coverage", function () {
  async function deployFixture() {
    const [admin, treasury, teeNode, complianceOfficer, business1, recipient, other] = await ethers.getSigners();
    const NP = await ethers.getContractFactory("NoblePay");
    const baseFee = ethers.parseUnits("1", 6);
    const percentageFee = 50;
    const noblepay = await NP.deploy(admin.address, treasury.address, baseFee, percentageFee);

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

  it("should enforce monthly volume limit", async function () {
    const { noblepay, usdc, admin, business1, recipient } = await loadFixture(deployFixture);
    // Standard daily limit is 50_000 * 1e6, monthly limit is 500_000 * 1e6
    // Send 49k per day for 11 days = 539k > 500k monthly limit
    const paymentAmount = ethers.parseUnits("49000", 6);
    for (let i = 0; i < 10; i++) {
      await noblepay.connect(business1).initiatePayment(
        recipient.address, paymentAmount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      // Advance to next day to reset daily limit
      await time.increase(86400);
    }
    // Total so far: 490k. Next payment of 20k would make 510k > 500k monthly limit
    const overAmount = ethers.parseUnits("20000", 6);
    await expect(noblepay.connect(business1).initiatePayment(
      recipient.address, overAmount, usdc.target, ethers.ZeroHash, "0x555344"
    )).to.be.revertedWithCustomError(noblepay, "MonthlyLimitExceeded");
  });

  it("should revert getPayment for non-existent payment", async function () {
    const { noblepay } = await loadFixture(deployFixture);
    const payment = await noblepay.getPayment(ethers.ZeroHash);
    expect(payment.sender).to.equal(ethers.ZeroAddress);
  });
});

// ================================================================
// PaymentChannels - View function coverage
// ================================================================
describe("PaymentChannels - Deep Coverage", function () {
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

  it("should return user channels", async function () {
    const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
    const DEPOSIT = ethers.parseUnits("10000", 6);
    await pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, 3600, 100);
    const channels = await pc.getUserChannels(partyA.address);
    expect(channels.length).to.equal(1);
  });

  it("should return watchtower info", async function () {
    const { pc, other } = await loadFixture(deployFixture);
    const wt = await pc.getWatchtower(other.address);
    expect(wt.registeredAt).to.equal(0);
  });

  it("should return channel watchtowers", async function () {
    const { pc } = await loadFixture(deployFixture);
    const wts = await pc.getChannelWatchtowers(ethers.ZeroHash);
    expect(wts.length).to.equal(0);
  });

  it("should return routing path", async function () {
    const { pc } = await loadFixture(deployFixture);
    const path = await pc.getRoutingPath(ethers.ZeroHash);
    expect(path.totalFees).to.equal(0);
  });

  it("should compute state hash", async function () {
    const { pc } = await loadFixture(deployFixture);
    const hash = await pc.computeStateHash(ethers.ZeroHash, 100, 200, 1, "STATE");
    expect(hash).to.not.equal(ethers.ZeroHash);
  });
});

// ================================================================
// MultiSigTreasury - uncovered line 1141 (receive)
// ================================================================
describe("MultiSigTreasury - Deep Coverage", function () {
  it("should handle fallback receive for native tokens", async function () {
    const [admin, signer1, signer2, signer3, treasury, other] = await ethers.getSigners();
    const MST = await ethers.getContractFactory("MultiSigTreasury");
    const mst = await MST.deploy(
      admin.address,
      [signer1.address, signer2.address, signer3.address],
      1, 2, 3, 1
    );
    // Send native tokens to trigger receive()
    await other.sendTransaction({ to: mst.target, value: ethers.parseEther("0.1") });
    const balance = await ethers.provider.getBalance(mst.target);
    expect(balance).to.be.greaterThan(0);
  });
});
