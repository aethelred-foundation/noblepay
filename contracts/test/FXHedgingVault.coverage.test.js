import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("FXHedgingVault - Coverage", function () {
  const RATE_PRECISION = 100000000n;
  const AED_USD_RATE = 367250000n;

  async function deployFixture() {
    const [admin, oracle, riskMgr, liquidator, hedger, other, treasuryAddr] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const FXVault = await ethers.getContractFactory("FXHedgingVault");
    const vault = await FXVault.deploy(admin.address, treasuryAddr.address, 100);

    const ORACLE_ROLE = await vault.ORACLE_ROLE();
    const RISK_MANAGER_ROLE = await vault.RISK_MANAGER_ROLE();
    const LIQUIDATOR_ROLE = await vault.LIQUIDATOR_ROLE();
    await vault.connect(admin).grantRole(ORACLE_ROLE, oracle.address);
    await vault.connect(admin).grantRole(RISK_MANAGER_ROLE, riskMgr.address);
    await vault.connect(admin).grantRole(LIQUIDATOR_ROLE, liquidator.address);

    await vault.connect(admin).setSupportedCollateral(usdc.target, true);

    const pairId = ethers.keccak256(ethers.solidityPacked(["bytes3", "bytes3"], ["0x414544", "0x555344"]));
    await vault.connect(admin).addCurrencyPair("0x414544", "0x555344", 10000, 500, 300);
    await vault.connect(oracle).submitFXRate(pairId, AED_USD_RATE);

    const amount = 100000000000000n;
    await usdc.mint(hedger.address, amount);
    await usdc.connect(hedger).approve(vault.target, ethers.MaxUint256);
    await usdc.mint(vault.target, amount);

    return { vault, usdc, admin, oracle, riskMgr, liquidator, hedger, other, treasuryAddr, pairId };
  }

  async function forwardCreatedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { vault, usdc, hedger, pairId } = fixture;
    const notional = 1000000n * RATE_PRECISION;
    const collateral = (notional * 500n) / 10000n;
    const maturity = BigInt(await time.latest()) + 86400n * 30n;

    const tx = await vault.connect(hedger).createForward(pairId, notional, maturity, usdc.target, collateral);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
    const positionId = event.args[0];
    return { ...fixture, positionId, notional, collateral, maturity };
  }

  describe("Constructor Edge Cases", function () {
    it("should revert with zero treasury", async function () {
      const FXVault = await ethers.getContractFactory("FXHedgingVault");
      const [a] = await ethers.getSigners();
      await expect(FXVault.deploy(a.address, ethers.ZeroAddress, 100))
        .to.be.revertedWithCustomError(FXVault, "ZeroAddress");
    });
  });

  describe("Forward Settlement - Loss Path", function () {
    it("should settle a matured forward with loss", async function () {
      const { vault, oracle, hedger, pairId, positionId, maturity } = await forwardCreatedFixture();
      await time.increaseTo(maturity);
      const lowerRate = 350000000n; // 3.50 (loss from 3.6725)
      await vault.connect(oracle).submitFXRate(pairId, lowerRate);
      await expect(vault.connect(hedger).settleForward(positionId))
        .to.emit(vault, "PositionSettled");
      const pos = await vault.getPosition(positionId);
      expect(pos.status).to.equal(2); // SETTLED
    });

    it("should settle forward with total loss (loss >= collateral)", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 1000000n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n; // 5% margin
      const maturity = BigInt(await time.latest()) + 86400n * 30n;

      const tx = await vault.connect(hedger).createForward(pairId, notional, maturity, usdc.target, collateral);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
      const positionId = event.args[0];

      await time.increaseTo(maturity);
      // Rate drops significantly to cause total loss
      const veryLowRate = 100000000n; // 1.00 (huge loss from 3.6725)
      await vault.connect(oracle).submitFXRate(pairId, veryLowRate);
      await vault.connect(hedger).settleForward(positionId);
      const pos = await vault.getPosition(positionId);
      expect(pos.settlementAmount).to.equal(0);
    });

    it("should handle settlement where fee > settlement amount", async function () {
      const { vault, usdc, admin, oracle, hedger, pairId } = await loadFixture(deployFixture);
      // Deploy with high fee
      const FXVault = await ethers.getContractFactory("FXHedgingVault");
      const [, , , , , , treasuryAddr2] = await ethers.getSigners();
      const vault2 = await FXVault.deploy(admin.address, treasuryAddr2.address, 500); // 5% fee
      await vault2.connect(admin).grantRole(await vault2.ORACLE_ROLE(), oracle.address);
      await vault2.connect(admin).setSupportedCollateral(usdc.target, true);
      await vault2.connect(admin).addCurrencyPair("0x414544", "0x555344", 10000, 500, 300);
      const pairId2 = ethers.keccak256(ethers.solidityPacked(["bytes3", "bytes3"], ["0x414544", "0x555344"]));
      await vault2.connect(oracle).submitFXRate(pairId2, AED_USD_RATE);

      // Small position with minimal collateral
      const notional = 100n * RATE_PRECISION;
      const collateral = (notional * 500n) / 10000n;
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await usdc.mint(hedger.address, collateral * 10n);
      await usdc.connect(hedger).approve(vault2.target, ethers.MaxUint256);
      await usdc.mint(vault2.target, collateral * 10n);

      const tx = await vault2.connect(hedger).createForward(pairId2, notional, maturity, usdc.target, collateral);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ForwardCreated");
      const posId = event.args[0];

      await time.increaseTo(maturity);
      // Drop rate so loss eats most collateral but not all
      const lossRate = 340000000n;
      await vault2.connect(oracle).submitFXRate(pairId2, lossRate);
      await vault2.connect(hedger).settleForward(posId);
    });
  });

  describe("Option Exercise", function () {
    async function callOptionFixture() {
      const fixture = await loadFixture(deployFixture);
      const { vault, usdc, hedger, pairId } = fixture;
      const notional = 100000n * RATE_PRECISION;
      const strike = 370000000n;
      const premium = ethers.parseUnits("1000", 6);
      const collateral = ethers.parseUnits("5000", 6);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 1, notional, strike, premium, maturity, usdc.target, collateral
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      const positionId = event.args[0];
      return { ...fixture, positionId, notional, strike, collateral, maturity };
    }

    it("should exercise an in-the-money call option", async function () {
      const { vault, oracle, hedger, pairId, positionId } = await callOptionFixture();
      // Rate above strike (call is ITM)
      await vault.connect(oracle).submitFXRate(pairId, 400000000n); // 4.00 > 3.70 strike
      await expect(vault.connect(hedger).exerciseOption(positionId))
        .to.emit(vault, "OptionExercised");
      const pos = await vault.getPosition(positionId);
      expect(pos.status).to.equal(3); // EXERCISED
    });

    it("should revert exercising out-of-money call option", async function () {
      const { vault, oracle, hedger, pairId, positionId } = await callOptionFixture();
      // Rate below strike (call is OTM)
      await vault.connect(oracle).submitFXRate(pairId, 350000000n);
      await expect(vault.connect(hedger).exerciseOption(positionId))
        .to.be.revertedWithCustomError(vault, "OptionNotInTheMoney");
    });

    it("should exercise an in-the-money put option", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 100000n * RATE_PRECISION;
      const strike = 370000000n;
      const premium = ethers.parseUnits("1000", 6);
      const collateral = ethers.parseUnits("5000", 6);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 2, notional, strike, premium, maturity, usdc.target, collateral // 2 = PUT
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      const positionId = event.args[0];

      // Rate below strike (put is ITM)
      await vault.connect(oracle).submitFXRate(pairId, 350000000n);
      await expect(vault.connect(hedger).exerciseOption(positionId))
        .to.emit(vault, "OptionExercised");
    });

    it("should revert exercising out-of-money put option", async function () {
      const { vault, usdc, oracle, hedger, pairId } = await loadFixture(deployFixture);
      const notional = 100000n * RATE_PRECISION;
      const strike = 370000000n;
      const collateral = ethers.parseUnits("5000", 6);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      const tx = await vault.connect(hedger).createOption(
        pairId, 2, notional, strike, ethers.parseUnits("500", 6), maturity, usdc.target, collateral
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "OptionCreated");
      const positionId = event.args[0];

      // Rate above strike (put is OTM)
      await vault.connect(oracle).submitFXRate(pairId, 400000000n);
      await expect(vault.connect(hedger).exerciseOption(positionId))
        .to.be.revertedWithCustomError(vault, "OptionNotInTheMoney");
    });

    it("should revert exercise by non-owner", async function () {
      const { vault, oracle, other, pairId, positionId } = await callOptionFixture();
      await vault.connect(oracle).submitFXRate(pairId, 400000000n);
      await expect(vault.connect(other).exerciseOption(positionId))
        .to.be.revertedWithCustomError(vault, "NotPositionOwner");
    });

    it("should revert exercise after maturity", async function () {
      const { vault, oracle, hedger, pairId, positionId, maturity } = await callOptionFixture();
      await time.increaseTo(maturity + 1n);
      await vault.connect(oracle).submitFXRate(pairId, 400000000n);
      await expect(vault.connect(hedger).exerciseOption(positionId))
        .to.be.revertedWithCustomError(vault, "PositionNotMatured");
    });
  });

  describe("Liquidation", function () {
    it("should liquidate an under-margined forward position", async function () {
      const { vault, usdc, oracle, liquidator, hedger, pairId, positionId } = await forwardCreatedFixture();
      // Drop rate significantly to cause under-margin
      const veryLowRate = 200000000n; // 2.00 (huge unrealized loss from 3.6725)
      await vault.connect(oracle).submitFXRate(pairId, veryLowRate);
      await expect(vault.connect(liquidator).liquidatePosition(positionId))
        .to.emit(vault, "PositionLiquidated");
      const pos = await vault.getPosition(positionId);
      expect(pos.status).to.equal(5); // LIQUIDATED
    });

    it("should revert liquidation if margin sufficient", async function () {
      const { vault, oracle, liquidator, pairId, positionId } = await forwardCreatedFixture();
      // Rate goes UP - no unrealized loss, margin is fine
      await vault.connect(oracle).submitFXRate(pairId, 380000000n);
      await expect(vault.connect(liquidator).liquidatePosition(positionId))
        .to.be.revertedWithCustomError(vault, "MarginSufficient");
    });

    it("should revert liquidation of non-active position", async function () {
      const { vault, admin, liquidator, positionId } = await forwardCreatedFixture();
      await vault.connect(admin).emergencyUnwind(positionId);
      await expect(vault.connect(liquidator).liquidatePosition(positionId))
        .to.be.revertedWithCustomError(vault, "InvalidPositionStatus");
    });
  });

  describe("Mark-to-Market - Loss Path", function () {
    it("should update MtM with lower rate (no unrealized PnL update)", async function () {
      const { vault, oracle, pairId, positionId } = await forwardCreatedFixture();
      await vault.connect(oracle).submitFXRate(pairId, 350000000n); // lower
      await expect(vault.connect(oracle).updateMarkToMarket(positionId))
        .to.emit(vault, "MarkToMarketUpdated");
    });
  });

  describe("Hedge Effectiveness - Zero hedged item change", function () {
    it("should assess with hedgedItemChange = 0", async function () {
      const { vault, oracle, riskMgr, pairId, positionId } = await forwardCreatedFixture();
      await vault.connect(oracle).submitFXRate(pairId, 380000000n);
      await expect(vault.connect(riskMgr).assessHedgeEffectiveness(positionId, 0))
        .to.emit(vault, "HedgeEffectivenessAssessed");
    });

    it("should assess with rate below locked (originalValue > currentValue)", async function () {
      const { vault, oracle, riskMgr, pairId, positionId } = await forwardCreatedFixture();
      await vault.connect(oracle).submitFXRate(pairId, 350000000n); // below locked
      await expect(vault.connect(riskMgr).assessHedgeEffectiveness(positionId, 1000000n))
        .to.emit(vault, "HedgeEffectivenessAssessed");
    });
  });

  describe("Settle Forward - Admin", function () {
    it("should allow admin to settle forward", async function () {
      const { vault, oracle, admin, pairId, positionId, maturity } = await forwardCreatedFixture();
      await time.increaseTo(maturity);
      await vault.connect(oracle).submitFXRate(pairId, 380000000n);
      await expect(vault.connect(admin).settleForward(positionId))
        .to.emit(vault, "PositionSettled");
    });
  });

  describe("Batch FX Rate Errors", function () {
    it("should revert batch with mismatched arrays", async function () {
      const { vault, oracle, pairId } = await loadFixture(deployFixture);
      await expect(vault.connect(oracle).batchSubmitFXRates([pairId], [AED_USD_RATE, 100n]))
        .to.be.revert(ethers);
    });
  });

  describe("Create Forward/Option Edge Cases", function () {
    it("should revert createOption with FORWARD type", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createOption(
        pairId, 0, 1000n * RATE_PRECISION, 370000000n, 100, maturity, usdc.target, ethers.parseUnits("5000", 6)
      )).to.be.revert(ethers);
    });

    it("should revert createOption with zero strike rate", async function () {
      const { vault, usdc, hedger, pairId } = await loadFixture(deployFixture);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createOption(
        pairId, 1, 1000n * RATE_PRECISION, 0, 100, maturity, usdc.target, ethers.parseUnits("5000", 6)
      )).to.be.revertedWithCustomError(vault, "InvalidRate");
    });

    it("should revert forward on inactive pair", async function () {
      const { vault, usdc, admin, hedger, pairId } = await loadFixture(deployFixture);
      await vault.connect(admin).setCurrencyPairActive(pairId, false);
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createForward(pairId, 1000n * RATE_PRECISION, maturity, usdc.target, ethers.parseUnits("5000", 6)))
        .to.be.revertedWithCustomError(vault, "PairNotActive");
    });
  });

  describe("Pause", function () {
    it("should prevent operations when paused", async function () {
      const { vault, admin, hedger, usdc, pairId } = await loadFixture(deployFixture);
      await vault.connect(admin).pause();
      const maturity = BigInt(await time.latest()) + 86400n * 30n;
      await expect(vault.connect(hedger).createForward(pairId, 1000n * RATE_PRECISION, maturity, usdc.target, ethers.parseUnits("5000", 6)))
        .to.be.revert(ethers);
    });
  });

  describe("View Functions", function () {
    it("should return position via getPosition", async function () {
      const { vault, positionId, hedger } = await forwardCreatedFixture();
      const pos = await vault.getPosition(positionId);
      expect(pos.hedger).to.equal(hedger.address);
    });
  });
});
