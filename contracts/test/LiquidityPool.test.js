import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("LiquidityPool", function () {
  async function deployFixture() {
    const [admin, treasury, lp1, lp2, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenA = await MockERC20.deploy("Token A", "TKA", 6);
    const tokenB = await MockERC20.deploy("Token B", "TKB", 6);

    // Ensure canonical ordering token0 < token1
    let token0, token1;
    if (tokenA.target < tokenB.target) {
      token0 = tokenA; token1 = tokenB;
    } else {
      token0 = tokenB; token1 = tokenA;
    }

    const Pool = await ethers.getContractFactory("LiquidityPool");
    const pool = await Pool.deploy(admin.address, treasury.address);

    const LP_ROLE = await pool.LIQUIDITY_PROVIDER_ROLE();
    await pool.connect(admin).grantRole(LP_ROLE, lp1.address);
    await pool.connect(admin).grantRole(LP_ROLE, lp2.address);

    // Mint tokens for LPs
    const amount = ethers.parseUnits("1000000", 6);
    await token0.mint(lp1.address, amount);
    await token1.mint(lp1.address, amount);
    await token0.mint(lp2.address, amount);
    await token1.mint(lp2.address, amount);

    // Approve pool
    await token0.connect(lp1).approve(pool.target, ethers.MaxUint256);
    await token1.connect(lp1).approve(pool.target, ethers.MaxUint256);
    await token0.connect(lp2).approve(pool.target, ethers.MaxUint256);
    await token1.connect(lp2).approve(pool.target, ethers.MaxUint256);

    return { pool, token0, token1, admin, treasury, lp1, lp2, other, LP_ROLE };
  }

  async function poolCreatedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { pool, token0, token1, admin } = fixture;
    const tx = await pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 8000);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PoolCreated");
    const poolId = event.args[0];
    return { ...fixture, poolId };
  }

  async function liquidityAddedFixture() {
    const fixture = await poolCreatedFixture();
    const { pool, lp1, poolId } = fixture;
    const amt = ethers.parseUnits("10000", 6);
    const tx = await pool.connect(lp1).addLiquidity(poolId, amt, amt, -100, 100);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "LiquidityAdded");
    const positionId = event.args[0];
    return { ...fixture, positionId };
  }

  describe("Deployment", function () {
    it("should set admin and treasury", async function () {
      const { pool, admin, treasury } = await loadFixture(deployFixture);
      const POOL_ADMIN_ROLE = await pool.POOL_ADMIN_ROLE();
      expect(await pool.hasRole(POOL_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await pool.treasury()).to.equal(treasury.address);
      expect(await pool.protocolFeeBP()).to.equal(1000);
    });

    it("should revert with zero admin", async function () {
      const Pool = await ethers.getContractFactory("LiquidityPool");
      const [, treasury] = await ethers.getSigners();
      await expect(Pool.deploy(ethers.ZeroAddress, treasury.address))
        .to.be.revertedWithCustomError(Pool, "ZeroAddress");
    });

    it("should revert with zero treasury", async function () {
      const Pool = await ethers.getContractFactory("LiquidityPool");
      const [admin] = await ethers.getSigners();
      await expect(Pool.deploy(admin.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Pool, "ZeroAddress");
    });
  });

  describe("Pool Creation", function () {
    it("should create a pool", async function () {
      const { pool, token0, token1, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 8000))
        .to.emit(pool, "PoolCreated");
    });

    it("should revert for non-canonical ordering", async function () {
      const { pool, token0, token1, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).createPool(token1.target, token0.target, 30, 10, 8000))
        .to.be.revertedWith("LiquidityPool: token0 must be < token1");
    });

    it("should revert duplicate pool", async function () {
      const { pool, token0, token1, admin } = await poolCreatedFixture();
      await expect(pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 8000))
        .to.be.revertedWithCustomError(pool, "PoolAlreadyExists");
    });

    it("should revert excessive fee rate", async function () {
      const { pool, token0, token1, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).createPool(token0.target, token1.target, 101, 10, 8000))
        .to.be.revertedWithCustomError(pool, "ExcessiveFeeRate");
    });

    it("should revert excessive flash fee rate", async function () {
      const { pool, token0, token1, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).createPool(token0.target, token1.target, 30, 51, 8000))
        .to.be.revertedWithCustomError(pool, "ExcessiveFeeRate");
    });

    it("should revert invalid imbalance threshold", async function () {
      const { pool, token0, token1, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 0))
        .to.be.revertedWithCustomError(pool, "InvalidImbalanceThreshold");
      await expect(pool.connect(admin).createPool(token0.target, token1.target, 30, 10, 9501))
        .to.be.revertedWithCustomError(pool, "InvalidImbalanceThreshold");
    });

    it("should revert with zero token address", async function () {
      const { pool, token0, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).createPool(ethers.ZeroAddress, token0.target, 30, 10, 8000))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("Liquidity Provision", function () {
    it("should add liquidity", async function () {
      const { pool, lp1, poolId } = await poolCreatedFixture();
      const amt = ethers.parseUnits("10000", 6);
      await expect(pool.connect(lp1).addLiquidity(poolId, amt, amt, -100, 100))
        .to.emit(pool, "LiquidityAdded");
      const p = await pool.getPool(poolId);
      expect(p.reserveToken0).to.equal(amt);
      expect(p.reserveToken1).to.equal(amt);
    });

    it("should revert for zero amounts", async function () {
      const { pool, lp1, poolId } = await poolCreatedFixture();
      await expect(pool.connect(lp1).addLiquidity(poolId, 0, 0, -100, 100))
        .to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("should revert for insufficient liquidity (below MIN_LIQUIDITY)", async function () {
      const { pool, lp1, poolId } = await poolCreatedFixture();
      await expect(pool.connect(lp1).addLiquidity(poolId, 500, 400, -100, 100))
        .to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("should revert for invalid tick range", async function () {
      const { pool, lp1, poolId } = await poolCreatedFixture();
      const amt = ethers.parseUnits("10000", 6);
      // tickLower >= tickUpper
      await expect(pool.connect(lp1).addLiquidity(poolId, amt, amt, 100, -100))
        .to.be.revertedWithCustomError(pool, "InvalidTickRange");
    });

    it("should revert for unaligned ticks", async function () {
      const { pool, lp1, poolId } = await poolCreatedFixture();
      const amt = ethers.parseUnits("10000", 6);
      await expect(pool.connect(lp1).addLiquidity(poolId, amt, amt, -15, 100))
        .to.be.revertedWithCustomError(pool, "TickNotAligned");
    });

    it("should remove liquidity", async function () {
      const { pool, lp1, poolId, positionId, token0, token1 } = await liquidityAddedFixture();
      const bal0Before = await token0.balanceOf(lp1.address);
      await pool.connect(lp1).removeLiquidity(poolId, positionId);
      const bal0After = await token0.balanceOf(lp1.address);
      expect(bal0After).to.be.gt(bal0Before);
      const pos = await pool.getPosition(positionId);
      expect(pos.active).to.be.false;
    });

    it("should revert remove by non-owner", async function () {
      const { pool, lp2, poolId, positionId } = await liquidityAddedFixture();
      await expect(pool.connect(lp2).removeLiquidity(poolId, positionId))
        .to.be.revertedWithCustomError(pool, "Unauthorized");
    });
  });

  describe("Pool Configuration", function () {
    it("should update pool config", async function () {
      const { pool, admin, poolId } = await poolCreatedFixture();
      await expect(pool.connect(admin).updatePoolConfig(poolId, 50, 20))
        .to.emit(pool, "PoolConfigUpdated");
    });

    it("should revert excessive fee on update", async function () {
      const { pool, admin, poolId } = await poolCreatedFixture();
      await expect(pool.connect(admin).updatePoolConfig(poolId, 101, 10))
        .to.be.revertedWithCustomError(pool, "ExcessiveFeeRate");
    });
  });

  describe("Circuit Breaker", function () {
    it("should update circuit breaker config", async function () {
      const { pool, admin, poolId } = await poolCreatedFixture();
      await pool.connect(admin).updateCircuitBreaker(poolId, 7000, 3600);
    });

    it("should revert invalid imbalance on update", async function () {
      const { pool, admin, poolId } = await poolCreatedFixture();
      await expect(pool.connect(admin).updateCircuitBreaker(poolId, 0, 3600))
        .to.be.revertedWithCustomError(pool, "InvalidImbalanceThreshold");
    });

    it("should trigger circuit breaker on extreme imbalance", async function () {
      const { pool, lp1, admin, poolId, token0, token1 } = await poolCreatedFixture();
      // Create pool with low imbalance threshold
      // Add very imbalanced liquidity - this should trigger circuit breaker
      // Pool has maxImbalanceBP=8000, so if one side has >80% of total, it triggers
      const bigAmt = ethers.parseUnits("100000", 6);
      const smallAmt = ethers.parseUnits("1000", 6); // 1% of total = 99% imbalance

      await expect(pool.connect(lp1).addLiquidity(poolId, bigAmt, smallAmt, -100, 100))
        .to.emit(pool, "CircuitBreakerTriggered");
    });

    it("should reset circuit breaker after cooldown", async function () {
      const { pool, lp1, admin, poolId } = await poolCreatedFixture();
      const bigAmt = ethers.parseUnits("100000", 6);
      const smallAmt = ethers.parseUnits("1000", 6);
      await pool.connect(lp1).addLiquidity(poolId, bigAmt, smallAmt, -100, 100);

      // Wait for cooldown
      await time.increase(3601); // > 1 hour
      await pool.connect(admin).resetCircuitBreaker(poolId);
    });

    it("should revert reset before cooldown", async function () {
      const { pool, lp1, admin, poolId } = await poolCreatedFixture();
      const bigAmt = ethers.parseUnits("100000", 6);
      const smallAmt = ethers.parseUnits("1000", 6);
      await pool.connect(lp1).addLiquidity(poolId, bigAmt, smallAmt, -100, 100);

      await expect(pool.connect(admin).resetCircuitBreaker(poolId))
        .to.be.revertedWithCustomError(pool, "CooldownNotElapsed");
    });
  });

  describe("View Functions", function () {
    it("should return pool utilization", async function () {
      const { pool, poolId } = await liquidityAddedFixture();
      const util = await pool.getPoolUtilization(poolId);
      expect(util).to.equal(5000); // 50% balanced
    });

    it("should return balanced utilization for empty pool", async function () {
      const { pool, poolId } = await poolCreatedFixture();
      const util = await pool.getPoolUtilization(poolId);
      expect(util).to.equal(5000);
    });

    it("should return pool TVL", async function () {
      const { pool, poolId } = await liquidityAddedFixture();
      const [t0, t1] = await pool.getPoolTVL(poolId);
      expect(t0).to.be.gt(0);
      expect(t1).to.be.gt(0);
    });

    it("should return provider position count", async function () {
      const { pool, lp1 } = await liquidityAddedFixture();
      expect(await pool.getProviderPositionCount(lp1.address)).to.equal(1);
    });

    it("should return pool health", async function () {
      const { pool, poolId } = await liquidityAddedFixture();
      expect(await pool.getPoolHealth(poolId)).to.equal(0); // HEALTHY
    });
  });

  describe("Admin", function () {
    it("should update treasury", async function () {
      const { pool, admin, other } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).setTreasury(other.address))
        .to.emit(pool, "TreasuryUpdated");
    });

    it("should revert zero treasury", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(pool, "ZeroAddress");
    });

    it("should set protocol fee", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).setProtocolFee(2000))
        .to.emit(pool, "ProtocolFeeUpdated");
    });

    it("should revert excessive protocol fee", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await expect(pool.connect(admin).setProtocolFee(5001))
        .to.be.revertedWithCustomError(pool, "InvalidProtocolFee");
    });

    it("should pause and unpause", async function () {
      const { pool, admin } = await loadFixture(deployFixture);
      await pool.connect(admin).pause();
      expect(await pool.paused()).to.be.true;
      await pool.connect(admin).unpause();
      expect(await pool.paused()).to.be.false;
    });
  });
});
