const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ================================================================
// MockERC20 - decimals() coverage
// ================================================================
describe("MockERC20 - Final Coverage", function () {
  it("should return correct decimals", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("Test", "TST", 8);
    expect(await token.decimals()).to.equal(8);
  });
});

// ================================================================
// ComplianceOracle - attestation and view functions
// ================================================================
describe("ComplianceOracle - Final Coverage", function () {
  async function deployFixture() {
    const [admin, teeNode1, teeNode2, other] = await ethers.getSigners();
    const CO = await ethers.getContractFactory("ComplianceOracle");
    const oracle = await CO.deploy(admin.address);
    const TEE_MANAGER_ROLE = await oracle.TEE_MANAGER_ROLE();
    await oracle.connect(admin).grantRole(TEE_MANAGER_ROLE, admin.address);
    return { oracle, admin, teeNode1, teeNode2, other };
  }

  it("should check isAttestationVerified", async function () {
    const { oracle } = await loadFixture(deployFixture);
    const hash = ethers.keccak256(ethers.toUtf8Bytes("attestation"));
    const verified = await oracle.isAttestationVerified(hash);
    expect(verified).to.be.false;
  });

  it("should return sanctions list version", async function () {
    const { oracle } = await loadFixture(deployFixture);
    const version = await oracle.getSanctionsListVersion(0);
    expect(version).to.equal(0);
  });

  it("should classify risk as LOW", async function () {
    const { oracle } = await loadFixture(deployFixture);
    const risk = await oracle.classifyRisk(10);
    expect(risk).to.equal("LOW");
  });

  it("should classify risk as MEDIUM", async function () {
    const { oracle } = await loadFixture(deployFixture);
    const risk = await oracle.classifyRisk(50);
    expect(risk).to.equal("MEDIUM");
  });

  it("should classify risk as HIGH", async function () {
    const { oracle } = await loadFixture(deployFixture);
    const risk = await oracle.classifyRisk(90);
    expect(risk).to.equal("HIGH");
  });
});

// ================================================================
// CrossChainRouter - relay auto-deactivation via zero reputation
// ================================================================
describe("CrossChainRouter - Final Coverage", function () {
  async function deployFixture() {
    const [admin, relay1, relay2, sender, recipient, other, treasuryAddr] = await ethers.getSigners();
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

    return { router, token, admin, relay1, relay2, sender, recipient, other, treasuryAddr };
  }

  it("should return relay node info", async function () {
    const { router, relay1 } = await loadFixture(deployFixture);
    const stake = await router.MIN_RELAY_STAKE();
    await router.connect(relay1).registerRelay({ value: stake });
    const relayInfo = await router.getRelayNode(relay1.address);
    expect(relayInfo.active).to.be.true;
  });

  it("should return transfer", async function () {
    const { router } = await loadFixture(deployFixture);
    const info = await router.getTransfer(ethers.ZeroHash);
    expect(info.sender).to.equal(ethers.ZeroAddress);
  });

  it("should return sender transfer count", async function () {
    const { router, sender } = await loadFixture(deployFixture);
    const count = await router.getSenderTransferCount(sender.address);
    expect(count).to.equal(0);
  });

  it("should return supported chain count", async function () {
    const { router } = await loadFixture(deployFixture);
    expect(await router.getSupportedChainCount()).to.equal(1);
  });
});

// ================================================================
// PaymentChannels - view functions coverage
// ================================================================
describe("PaymentChannels - Final Coverage", function () {
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

  it("should return dispute record", async function () {
    const { pc } = await loadFixture(deployFixture);
    const d = await pc.getDispute(ethers.ZeroHash);
    expect(d.challenger).to.equal(ethers.ZeroAddress);
  });

  it("should return HTLC record", async function () {
    const { pc } = await loadFixture(deployFixture);
    const h = await pc.getHTLC(ethers.ZeroHash);
    expect(h.amount).to.equal(0);
  });

  it("should return channel HTLCs", async function () {
    const { pc } = await loadFixture(deployFixture);
    const ids = await pc.getChannelHTLCs(ethers.ZeroHash);
    expect(ids.length).to.equal(0);
  });

  it("should batch set KYC status", async function () {
    const { pc, admin, other } = await loadFixture(deployFixture);
    await pc.connect(admin).batchSetKYCStatus([other.address], [true]);
    expect(await pc.kycVerified(other.address)).to.be.true;
  });
});

// ================================================================
// FXHedgingVault - remaining uncovered paths
// ================================================================
describe("FXHedgingVault - Final Coverage", function () {
  async function deployFixture() {
    const [admin, hedger, oracle, liquidator, other, treasuryAddr] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const collateral = await MockERC20.deploy("USDC", "USDC", 6);

    const FXV = await ethers.getContractFactory("FXHedgingVault");
    const vault = await FXV.deploy(admin.address, treasuryAddr.address, 100);

    const ORACLE_ROLE = await vault.ORACLE_ROLE();
    const LIQUIDATOR_ROLE = await vault.LIQUIDATOR_ROLE();
    await vault.connect(admin).grantRole(ORACLE_ROLE, oracle.address);
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
    await collateral.mint(liquidator.address, mintAmount);
    await collateral.connect(liquidator).approve(vault.target, ethers.MaxUint256);

    return { vault, collateral, admin, hedger, oracle, liquidator, other, treasuryAddr, pairId };
  }

  it("should revert createForward with inactive pair", async function () {
    const { vault, collateral, hedger, admin, pairId } = await loadFixture(deployFixture);
    await vault.connect(admin).setCurrencyPairActive(pairId, false);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    await expect(vault.connect(hedger).createForward(
      pairId, ethers.parseUnits("1000", 6), maturity, collateral.target, ethers.parseUnits("200", 6)
    )).to.be.revertedWithCustomError(vault, "PairNotActive");
  });

  it("should revert createForward with zero notional", async function () {
    const { vault, collateral, hedger, pairId } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    await expect(vault.connect(hedger).createForward(
      pairId, 0, maturity, collateral.target, ethers.parseUnits("200", 6)
    )).to.be.revertedWithCustomError(vault, "ZeroAmount");
  });

  it("should revert createForward with maturity in past", async function () {
    const { vault, collateral, hedger, pairId } = await loadFixture(deployFixture);
    await expect(vault.connect(hedger).createForward(
      pairId, ethers.parseUnits("1000", 6), 1, collateral.target, ethers.parseUnits("200", 6)
    )).to.be.revertedWithCustomError(vault, "MaturityInPast");
  });

  it("should revert createForward with unsupported collateral", async function () {
    const { vault, hedger, other, pairId } = await loadFixture(deployFixture);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    await expect(vault.connect(hedger).createForward(
      pairId, ethers.parseUnits("1000", 6), maturity, other.address, ethers.parseUnits("200", 6)
    )).to.be.revertedWithCustomError(vault, "UnsupportedCollateral");
  });

  it("should check isUnderMargined for forward with no loss", async function () {
    const { vault, collateral, hedger, oracle, pairId } = await loadFixture(deployFixture);
    const notional = ethers.parseUnits("100000", 6);
    const coll = ethers.parseUnits("15000", 6);
    const maturity = BigInt(await time.latest()) + 86400n * 90n;
    const tx = await vault.connect(hedger).createForward(pairId, notional, maturity, collateral.target, coll);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
    const positionId = event.args[0];

    // Rate goes UP - no unrealized loss
    await vault.connect(oracle).submitFXRate(pairId, 400000000n);
    const underMargined = await vault.isUnderMargined(positionId);
    expect(underMargined).to.be.false;
  });

  it("should return portfolio info", async function () {
    const { vault, hedger } = await loadFixture(deployFixture);
    const portfolio = await vault.getPortfolio(hedger.address);
    expect(portfolio.positionCount).to.equal(0);
  });

  it("should return business positions", async function () {
    const { vault, hedger } = await loadFixture(deployFixture);
    const positions = await vault.getBusinessPositions(hedger.address);
    expect(positions.length).to.equal(0);
  });
});

// ================================================================
// InvoiceFinancing - credit score volume bonus branches
// ================================================================
describe("InvoiceFinancing - Final Coverage", function () {
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

    const mintAmount = ethers.parseUnits("1000000000", 6);
    await token.mint(creditor.address, mintAmount);
    await token.mint(debtor.address, mintAmount);
    await token.mint(factor.address, mintAmount);
    await token.connect(creditor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(debtor).approve(invoicing.target, ethers.MaxUint256);
    await token.connect(factor).approve(invoicing.target, ethers.MaxUint256);

    return { invoicing, token, admin, factor, analyst, arbiter, creditor, debtor, other, treasuryAddr };
  }

  it("should trigger volume bonus in credit score calculation via large repayment", async function () {
    const { invoicing, token, creditor, debtor } = await loadFixture(deployFixture);
    // Create and repay multiple high-value invoices to build up totalValueRepaid
    const faceValue = ethers.parseUnits("200000", 6); // 200k per invoice
    for (let i = 0; i < 6; i++) {
      const maturity = BigInt(await time.latest()) + 86400n * 90n;
      const docHash = ethers.keccak256(ethers.toUtf8Bytes(`inv-${i}`));
      const tx = await invoicing.connect(creditor).createInvoice(
        debtor.address, faceValue, token.target, maturity, docHash, 7, 200
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "InvoiceCreated");
      const invoiceId = event.args[0];
      // Repay immediately
      await invoicing.connect(debtor).repayInvoice(invoiceId, faceValue);
    }
    // totalValueRepaid should now be 1.2M > 1M, triggering volumeBonus = 30
    const cp = await invoicing.getCreditProfile(debtor.address);
    expect(cp.totalValueRepaid).to.be.greaterThan(ethers.parseUnits("1000000", 6));
  });

  it("should return dispute via getDispute", async function () {
    const { invoicing } = await loadFixture(deployFixture);
    const d = await invoicing.getDispute(ethers.ZeroHash);
    expect(d.initiatedAt).to.equal(0);
  });

  it("should return debtor invoices", async function () {
    const { invoicing, debtor } = await loadFixture(deployFixture);
    const invs = await invoicing.getDebtorInvoices(debtor.address);
    expect(invs.length).to.equal(0);
  });

  it("should set protocol fee", async function () {
    const { invoicing, admin } = await loadFixture(deployFixture);
    await invoicing.connect(admin).setProtocolFee(200);
  });

  it("should set supported token", async function () {
    const { invoicing, admin, other } = await loadFixture(deployFixture);
    await invoicing.connect(admin).setSupportedToken(other.address, true);
  });
});

// ================================================================
// NoblePay - remaining lines
// ================================================================
describe("NoblePay - Final Coverage", function () {
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

  it("should revert submitComplianceResult for non-PENDING payment", async function () {
    const { noblepay, usdc, teeNode, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("100", 6);
    const tx = await noblepay.connect(business1).initiatePayment(
      recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
    const paymentId = event.args[0];

    // Submit compliance once (changes to APPROVED)
    await noblepay.connect(teeNode).submitComplianceResult(
      paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
    );

    // Try to submit again on non-PENDING payment
    await expect(noblepay.connect(teeNode).submitComplianceResult(
      paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
    )).to.be.revertedWithCustomError(noblepay, "InvalidPaymentStatus");
  });

  it("should revert submitComplianceResult with invalid risk score", async function () {
    const { noblepay, usdc, teeNode, business1, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("100", 6);
    const tx = await noblepay.connect(business1).initiatePayment(
      recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
    const paymentId = event.args[0];

    await expect(noblepay.connect(teeNode).submitComplianceResult(
      paymentId, true, 101, true, ethers.ZeroHash, "0x1234"
    )).to.be.revertedWithCustomError(noblepay, "InvalidRiskScore");
  });

  it("should revert settle for non-existent payment", async function () {
    const { noblepay } = await loadFixture(deployFixture);
    await expect(noblepay.settlePayment(ethers.ZeroHash))
      .to.be.revertedWithCustomError(noblepay, "PaymentNotFound");
  });

  it("should return getDailyLimit for enterprise tier", async function () {
    const { noblepay } = await loadFixture(deployFixture);
    expect(await noblepay.getDailyLimit(2)).to.equal(5000000n * 1000000n);
  });
});

// ================================================================
// LiquidityPool - remaining branches
// ================================================================
describe("LiquidityPool - Final Coverage", function () {
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

    const poolTx = await pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 8000);
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

  it("should return position info", async function () {
    const { pool } = await loadFixture(deployFixture);
    const pos = await pool.getPosition(ethers.ZeroHash);
    expect(pos.active).to.be.false;
  });

  it("should revert addLiquidity for non-LP role", async function () {
    const { pool, other, poolId } = await loadFixture(deployFixture);
    await expect(pool.connect(other).addLiquidity(poolId, 100, 100, -1000, 1000))
      .to.be.reverted;
  });

  it("should revert removeLiquidity for non-owner", async function () {
    const { pool, provider, other, poolId } = await loadFixture(deployFixture);
    const amount0 = ethers.parseEther("10000");
    const amount1 = ethers.parseEther("10000");
    const tx = await pool.connect(provider).addLiquidity(poolId, amount0, amount1, -1000, 1000);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "LiquidityAdded");
    const positionId = event.args[0];

    await expect(pool.connect(other).removeLiquidity(poolId, positionId))
      .to.be.revertedWithCustomError(pool, "Unauthorized");
  });
});

// ================================================================
// TravelRule - reject non-PENDING and view functions
// ================================================================
describe("TravelRule - Final Coverage", function () {
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

  it("should revert reject on already verified record", async function () {
    const { tr, teeNode, vasp1, vasp2 } = await loadFixture(deployFixture);
    const paymentId = ethers.keccak256(ethers.toUtf8Bytes("reject-test"));
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

    // Verify first
    await tr.connect(teeNode).verifyTravelRuleCompliance(travelRuleId);

    // Now reject should fail (no longer PENDING)
    await expect(tr.connect(teeNode).rejectTravelRuleData(travelRuleId, "too late"))
      .to.be.revertedWithCustomError(tr, "InvalidStatus");
  });
});

// ================================================================
// BusinessRegistry - additional branch coverage
// ================================================================
describe("BusinessRegistry - Final Coverage", function () {
  async function deployFixture() {
    const [admin, verifier, biz1, biz2, officer1, officer2, other] = await ethers.getSigners();
    const BR = await ethers.getContractFactory("BusinessRegistry");
    const br = await BR.deploy(admin.address);
    const VERIFIER_ROLE = await br.VERIFIER_ROLE();
    await br.connect(admin).grantRole(VERIFIER_ROLE, verifier.address);
    return { br, admin, verifier, biz1, biz2, officer1, officer2, other };
  }

  it("should return business details", async function () {
    const { br, other } = await loadFixture(deployFixture);
    const info = await br.getBusinessDetails(other.address);
    expect(info.registeredAt).to.equal(0);
  });

  it("should return business tier", async function () {
    const { br, other } = await loadFixture(deployFixture);
    const tier = await br.getBusinessTier(other.address);
    expect(tier).to.equal(0);
  });
});

// ================================================================
// StreamingPayments - edge case branches
// ================================================================
describe("StreamingPayments - Final Coverage", function () {
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

  it("should return 0 withdrawable before cliff", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    const duration = 86400;
    const cliffPeriod = 3600;
    const tx = await sp.connect(sender).createStream(recipient.address, token.target, amount, duration, cliffPeriod);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];

    const withdrawable = await sp.withdrawableBalance(streamId);
    expect(withdrawable).to.equal(0);
  });

  it("should return stream info", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    const tx = await sp.connect(sender).createStream(recipient.address, token.target, amount, 86400, 0);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];

    const stream = await sp.getStream(streamId);
    expect(stream.sender).to.equal(sender.address);
  });

  it("should return sender stream count", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    await sp.connect(sender).createStream(recipient.address, token.target, amount, 86400, 0);
    const count = await sp.getSenderStreamCount(sender.address);
    expect(count).to.equal(1);
  });

  it("should return recipient stream count", async function () {
    const { sp, token, sender, recipient } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("10000", 6);
    await sp.connect(sender).createStream(recipient.address, token.target, amount, 86400, 0);
    const count = await sp.getRecipientStreamCount(recipient.address);
    expect(count).to.equal(1);
  });
});

// ================================================================
// MultiSigTreasury - remaining line 1141
// ================================================================
describe("MultiSigTreasury - Final Coverage", function () {
  async function deployFixture() {
    const [admin, s1, s2, s3, s4, other] = await ethers.getSigners();
    const MST = await ethers.getContractFactory("MultiSigTreasury");
    const mst = await MST.deploy(admin.address, [s1.address, s2.address, s3.address, s4.address], 1, 2, 3, 1);
    return { mst, admin, s1, s2, s3, s4, other };
  }

  it("should return signer config", async function () {
    const { mst } = await loadFixture(deployFixture);
    const config = await mst.getSignerConfig();
    expect(config.totalSigners).to.equal(4);
  });

  it("should check hasApproved", async function () {
    const { mst, s1 } = await loadFixture(deployFixture);
    const approved = await mst.hasApproved(ethers.ZeroHash, s1.address);
    expect(approved).to.be.false;
  });
});
