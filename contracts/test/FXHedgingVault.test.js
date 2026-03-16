const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("FXHedgingVault", function () {
  const RATE_PRECISION = 100000000n; // 1e8
  const AED_USD_RATE = 367250000n; // 3.6725

  async function deployFixture() {
    const [admin, oracle, riskMgr, liquidator, hedger, other, treasuryAddr] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const FXVault = await ethers.getContractFactory("FXHedgingVault");
    const vault = await FXVault.deploy(admin.address, treasuryAddr.address, 100); // 1% fee

    // Grant roles
    const ORACLE_ROLE = await vault.ORACLE_ROLE();
    const RISK_MANAGER_ROLE = await vault.RISK_MANAGER_ROLE();
    const LIQUIDATOR_ROLE = await vault.LIQUIDATOR_ROLE();
    await vault.connect(admin).grantRole(ORACLE_ROLE, oracle.address);
    await vault.connect(admin).grantRole(RISK_MANAGER_ROLE, riskMgr.address);
    await vault.connect(admin).grantRole(LIQUIDATOR_ROLE, liquidator.address);

    // Setup collateral
    await vault.connect(admin).setSupportedCollateral(usdc.target, true);

    // Add currency pair AED/USD: margin 500bp (5%), maintenance 300bp (3%)
    const pairId = ethers.keccak256(ethers.solidityPacked(["bytes3", "bytes3"], ["0x414544", "0x555344"]));
    await vault.connect(admin).addCurrencyPair("0x414544", "0x555344", 10000, 500, 300);

    // Submit initial rate
    await vault.connect(oracle).submitFXRate(pairId, AED_USD_RATE);

    // Mint USDC for hedger (need large amounts since collateral is in 8-dec precision)
    const amount = 100000000000000n; // 1e14
    await usdc.mint(hedger.address, amount);
    await usdc.connect(hedger).approve(vault.target, ethers.MaxUint256);

    // Mint extra to vault for settlement payouts
    await usdc.mint(vault.target, amount);

    return { vault, usdc, admin, oracle, riskMgr, liquidator, hedger, other, treasuryAddr, pairId };
  }

  async function forwardCreatedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { vault, usdc, hedger, pairId } = fixture;
    const notional = 1000000n * RATE_PRECISION; // 1M units (1e14)
    const collateral = (notional * 500n) / 10000n; // 5% margin = 5e12
    const maturity = BigInt(await time.latest()) + 86400n * 30n; // 30 days

    const tx = await vault.connect(hedger).createForward(pairId, notional, maturity, usdc.target, collateral);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
    const positionId = event.args[0];
    return { ...fixture, positionId, notional, collateral, maturity };
  }

  describe("Deployment", function () {
    it("should set admin, treasury and fee", async function () {
      const { vault, admin, treasuryAddr } = await loadFixture(deployFixture);
      const ADMIN_ROLE = await vault.ADMIN_ROLE();
      expect(await vault.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await vault.treasury()).to.equal(treasuryAddr.address);
      expect(await vault.settlementFeeBps()).to.equal(100);
    });

    it("should revert with zero admin", async function () {
      const FXVault = await ethers.getContractFactory("FXHedgingVault");
      const [, t] = await ethers.getSigners();
      await expect(FXVault.deploy(ethers.ZeroAddress, t.address, 100))
        .to.be.revertedWithCustomError(FXVault, "ZeroAddress");
    });

    it("should revert with excessive fee", async function () {
      const FXVault = await ethers.getContractFactory("FXHedgingVault");
      const [a, t] = await ethers.getSigners();
      await expect(FXVault.deploy(a.address, t.address, 501))
        .to.be.revertedWithCustomError(FXVault, "InvalidFee");
    });
  });

  describe("Currency Pairs", function () {
    it("should add a currency pair", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).addCurrencyPair("0x475250", "0x555344", 10000, 500, 300))
        .to.emit(vault, "CurrencyPairAdded");
    });

    it("should revert duplicate pair", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).addCurrencyPair("0x414544", "0x555344", 10000, 500, 300))
        .to.be.revertedWithCustomError(vault, "PairAlreadyExists");
    });

    it("should toggle pair active status", async function () {
      const { vault, admin, pairId } = await loadFixture(deployFixture);
      await vault.connect(admin).setCurrencyPairActive(pairId, false);
      const pair = await vault.getCurrencyPair(pairId);
      expect(pair.active).to.be.false;
    });
  });

  describe("FX Rate Submission", function () {
    it("should submit FX rate", async function () {
      const { vault, oracle, pairId } = await loadFixture(deployFixture);
      await expect(vault.connect(oracle).submitFXRate(pairId, 370000000n))
        .to.emit(vault, "FXRateUpdated");
    });

    it("should revert zero rate", async function () {
      const { vault, oracle, pairId } = await loadFixture(deployFixture);
      await expect(vault.connect(oracle).submitFXRate(pairId, 0))
        .to.be.revertedWithCustomError(vault, "InvalidRate");
    });

    it("should batch submit rates", async function () {
      const { vault, oracle, admin, pairId } = await loadFixture(deployFixture);
      // Add another pair
      await vault.connect(admin).addCurrencyPair("0x475250", "0x555344", 10000, 500, 300);
      const pairId2 = ethers.keccak256(ethers.solidityPacked(["bytes3", "bytes3"], ["0x475250", "0x555344"]));
      await vault.connect(oracle).batchSubmitFXRates([pairId, pairId2], [AED_USD_RATE, 130000000n]);
    });

    it("should revert for non-oracle", async function () {
      const { vault, other, pairId } = await loadFixture(deployFixture);
      await expect(vault.connect(other).submitFXRate(pairId, AED_USD_RATE))
        .to.be.reverted;
    });
  });

  describe("Forward Contracts", function () {
    it("should create a forward", async function () {
      const { vault, positionId } = await forwardCreatedFixture();
      const pos = await vault.getPosition(positionId);
      expect(pos.hedgeType).to.equal(0); // FORWARD
      expect(pos.status).to.equal(0); // ACTIVE
    });

    it("should revert with insufficient margin", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 1000000n * RATE_PRECISION;
      const lowCollateral = ethers.parseUnits("100", 6); // way too low
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createForward(pairId, notional, maturity, usdc.target, lowCollateral))
        .to.be.revertedWithCustomError(vault, "InsufficientMargin");
    });

    it("should revert with maturity in the past", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFixture);
      await expect(vault.connect(hedger).createForward(pairId, 1000n * RATE_PRECISION, 1, usdc.target, ethers.parseUnits("50000", 6)))
        .to.be.revertedWithCustomError(vault, "MaturityInPast");
    });

    it("should settle a matured forward with gain", async function () {
      const { vault, oracle, hedger, pairId, positionId, maturity } = await forwardCreatedFixture();
      // Advance to maturity
      await time.increaseTo(maturity);
      // Submit a higher rate (base currency appreciated)
      const higherRate = 380000000n; // 3.80
      await vault.connect(oracle).submitFXRate(pairId, higherRate);
      await expect(vault.connect(hedger).settleForward(positionId))
        .to.emit(vault, "PositionSettled");
      const pos = await vault.getPosition(positionId);
      expect(pos.status).to.equal(2); // SETTLED
    });

    it("should revert settle before maturity", async function () {
      const { vault, hedger, positionId } = await forwardCreatedFixture();
      await expect(vault.connect(hedger).settleForward(positionId))
        .to.be.revertedWithCustomError(vault, "PositionNotMatured");
    });
  });

  describe("Options", function () {
    it("should create a call option", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 100000n * RATE_PRECISION;
      const strike = 370000000n;
      const premium = ethers.parseUnits("1000", 6);
      const collateral = ethers.parseUnits("5000", 6);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createOption(
        pairId, 1, notional, strike, premium, maturity, usdc.target, collateral
      )).to.emit(vault, "OptionCreated");
    });

    it("should expire an out-of-money option after maturity", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 100000n * RATE_PRECISION;
      const strike = 400000000n; // very high strike for call
      const premium = ethers.parseUnits("500", 6);
      const collateral = ethers.parseUnits("5000", 6);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 1, notional, strike, premium, maturity, usdc.target, collateral
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      const positionId = event.args[0];

      await time.increaseTo(maturity + 1n);
      await expect(vault.connect(hedger).expireOption(positionId))
        .to.emit(vault, "OptionExpired");
    });

    it("should revert expire before maturity", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 100000n * RATE_PRECISION;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 1, notional, 370000000n, ethers.parseUnits("500", 6), maturity, usdc.target, ethers.parseUnits("5000", 6)
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      const positionId = event.args[0];
      await expect(vault.connect(hedger).expireOption(positionId))
        .to.be.revertedWithCustomError(vault, "PositionNotMatured");
    });
  });

  describe("Margin", function () {
    it("should add margin", async function () {
      const { vault, hedger, positionId } = await forwardCreatedFixture();
      const addAmt = ethers.parseUnits("10000", 6);
      await expect(vault.connect(hedger).addMargin(positionId, addAmt))
        .to.emit(vault, "MarginAdded");
    });

    it("should revert add margin with zero", async function () {
      const { vault, hedger, positionId } = await forwardCreatedFixture();
      await expect(vault.connect(hedger).addMargin(positionId, 0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert add margin by non-owner", async function () {
      const { vault, other, positionId } = await forwardCreatedFixture();
      await expect(vault.connect(other).addMargin(positionId, 1000))
        .to.be.revertedWithCustomError(vault, "NotPositionOwner");
    });
  });

  describe("Mark-to-Market", function () {
    it("should update MtM valuation", async function () {
      const { vault, oracle, pairId, positionId } = await forwardCreatedFixture();
      await vault.connect(oracle).submitFXRate(pairId, 380000000n);
      await expect(vault.connect(oracle).updateMarkToMarket(positionId))
        .to.emit(vault, "MarkToMarketUpdated");
    });
  });

  describe("Hedge Effectiveness", function () {
    it("should assess hedge effectiveness", async function () {
      const { vault, oracle, riskMgr, pairId, positionId } = await forwardCreatedFixture();
      await vault.connect(oracle).submitFXRate(pairId, 380000000n);
      await expect(vault.connect(riskMgr).assessHedgeEffectiveness(positionId, 1000000n))
        .to.emit(vault, "HedgeEffectivenessAssessed");
    });
  });

  describe("Emergency Unwind", function () {
    it("should emergency unwind a position", async function () {
      const { vault, admin, positionId } = await forwardCreatedFixture();
      await expect(vault.connect(admin).emergencyUnwind(positionId))
        .to.emit(vault, "EmergencyUnwind");
      const pos = await vault.getPosition(positionId);
      expect(pos.status).to.equal(6); // EMERGENCY_UNWOUND
    });
  });

  describe("Admin", function () {
    it("should update treasury", async function () {
      const { vault, admin, other } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setTreasury(other.address))
        .to.emit(vault, "TreasuryUpdated");
    });

    it("should update settlement fee", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setSettlementFee(200))
        .to.emit(vault, "SettlementFeeUpdated");
    });

    it("should revert excessive settlement fee", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setSettlementFee(501))
        .to.be.revertedWithCustomError(vault, "InvalidFee");
    });

    it("should set collateral support", async function () {
      const { vault, admin, other } = await loadFixture(deployFixture);
      await expect(vault.connect(admin).setSupportedCollateral(other.address, true))
        .to.emit(vault, "CollateralTokenUpdated");
    });

    it("should pause and unpause", async function () {
      const { vault, admin } = await loadFixture(deployFixture);
      await vault.connect(admin).pause();
      expect(await vault.paused()).to.be.true;
      await vault.connect(admin).unpause();
    });
  });
});
