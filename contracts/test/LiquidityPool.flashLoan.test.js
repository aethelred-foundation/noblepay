const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("LiquidityPool - flash loan callback", function () {
  const UNDERPAY = 1;
  const REVERT_CALLBACK = 2;
  const INVALID_RETURN = 3;
  const REENTER = 4;

  async function deployFixture() {
    const [admin, treasury, provider, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenA = await MockERC20.deploy("Token A", "TKA", 18);
    const tokenB = await MockERC20.deploy("Token B", "TKB", 18);
    const [token0, token1] =
      BigInt(tokenA.target) < BigInt(tokenB.target)
        ? [tokenA, tokenB]
        : [tokenB, tokenA];

    const LiquidityPool = await ethers.getContractFactory("LiquidityPool");
    const pool = await LiquidityPool.deploy(admin.address, treasury.address);
    const Receiver = await ethers.getContractFactory("MockFlashLoanReceiver");
    const receiver = await Receiver.deploy(pool.target);

    const providerRole = await pool.LIQUIDITY_PROVIDER_ROLE();
    await pool.connect(admin).grantRole(providerRole, provider.address);

    const createTx = await pool
      .connect(admin)
      .createPool(token0.target, token1.target, 30, 10, 8000);
    const createReceipt = await createTx.wait();
    const poolId = createReceipt.logs.find(
      (log) => log.fragment?.name === "PoolCreated",
    ).args.poolId;

    const liquidity = ethers.parseEther("10000");
    await token0.mint(provider.address, liquidity);
    await token1.mint(provider.address, liquidity);
    await token0.connect(provider).approve(pool.target, liquidity);
    await token1.connect(provider).approve(pool.target, liquidity);
    await pool
      .connect(provider)
      .addLiquidity(poolId, liquidity, liquidity, -100, 100);

    return {
      pool,
      poolId,
      receiver,
      token0,
      token1,
      other,
      liquidity,
    };
  }

  async function fundFee(token, receiver, amount) {
    const fee = (amount * 10n) / 10_000n;
    await token.mint(receiver.target, fee);
    return fee;
  }

  it("executes the callback, forwards data, and accounts for repayment plus fee", async function () {
    const { pool, poolId, receiver, token0, liquidity } =
      await loadFixture(deployFixture);
    const amount = ethers.parseEther("100");
    const fee = await fundFee(token0, receiver, amount);
    const callbackData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "string"],
      [receiver.target, 42, "forwarded exactly"],
    );

    const tx = await receiver.requestFlashLoan(
      poolId,
      token0.target,
      amount,
      callbackData,
    );
    const receipt = await tx.wait();
    const initiated = receipt.logs
      .map((log) => {
        try {
          return pool.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "FlashLoanInitiated");
    const flashLoanId = initiated.args.flashLoanId;

    expect(initiated.args.borrower).to.equal(receiver.target);
    expect(initiated.args.amount).to.equal(amount);
    expect(initiated.args.fee).to.equal(fee);
    expect(await receiver.lastInitiator()).to.equal(receiver.target);
    expect(await receiver.lastToken()).to.equal(token0.target);
    expect(await receiver.lastAmount()).to.equal(amount);
    expect(await receiver.lastFee()).to.equal(fee);
    expect(await receiver.lastDataHash()).to.equal(
      ethers.keccak256(callbackData),
    );
    expect(await token0.balanceOf(receiver.target)).to.equal(0);
    expect(await token0.balanceOf(pool.target)).to.equal(liquidity + fee);
    expect(await pool.poolFeesCollected(poolId, token0.target)).to.equal(fee);

    const poolState = await pool.getPool(poolId);
    expect(poolState.reserveToken0).to.equal(liquidity + fee);
    const record = await pool.flashLoans(flashLoanId);
    expect(record.borrower).to.equal(receiver.target);
    expect(record.repaid).to.equal(true);
  });

  it("reverts atomically when the receiver under-approves repayment", async function () {
    const { pool, poolId, receiver, token0, liquidity } =
      await loadFixture(deployFixture);
    const amount = ethers.parseEther("100");
    await fundFee(token0, receiver, amount);
    await receiver.setBehavior(UNDERPAY);

    await expect(
      receiver.requestFlashLoan(poolId, token0.target, amount, "0x"),
    ).to.be.revertedWith("ERC20: insufficient allowance");

    expect(await token0.balanceOf(pool.target)).to.equal(liquidity);
    expect(await pool.flashLoanNonce()).to.equal(0);
  });

  it("bubbles a receiver callback failure and rolls back the loan", async function () {
    const { pool, poolId, receiver, token0, liquidity } =
      await loadFixture(deployFixture);
    const amount = ethers.parseEther("100");
    await fundFee(token0, receiver, amount);
    await receiver.setBehavior(REVERT_CALLBACK);

    await expect(
      receiver.requestFlashLoan(poolId, token0.target, amount, "0x1234"),
    ).to.be.revertedWithCustomError(receiver, "CallbackRejected");

    expect(await token0.balanceOf(pool.target)).to.equal(liquidity);
    expect(await pool.flashLoanNonce()).to.equal(0);
  });

  it("rejects a callback that does not return the ERC-3156 success value", async function () {
    const { pool, poolId, receiver, token0 } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("100");
    await fundFee(token0, receiver, amount);
    await receiver.setBehavior(INVALID_RETURN);

    await expect(receiver.requestFlashLoan(poolId, token0.target, amount, "0x"))
      .to.be.revertedWithCustomError(pool, "InvalidFlashLoanCallback")
      .withArgs(ethers.ZeroHash);
  });

  it("blocks callback reentrancy while allowing the outer loan to repay", async function () {
    const { pool, poolId, receiver, token1 } = await loadFixture(deployFixture);
    const amount = ethers.parseEther("100");
    await fundFee(token1, receiver, amount);
    await receiver.setBehavior(REENTER);

    await expect(
      receiver.requestFlashLoan(poolId, token1.target, amount, "0xbeef"),
    ).to.emit(pool, "FlashLoanRepaid");

    const expectedRevert = ethers.concat([
      ethers.id("Error(string)").slice(0, 10),
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string"],
        ["ReentrancyGuard: reentrant call"],
      ),
    ]);
    expect(await receiver.lastReentrySucceeded()).to.equal(false);
    expect(await receiver.lastReentryRevert()).to.equal(expectedRevert);
    expect(await pool.flashLoanNonce()).to.equal(1);
  });

  it("rejects an EOA receiver before any funds leave the pool", async function () {
    const { pool, poolId, token0, other } = await loadFixture(deployFixture);

    await expect(
      pool.connect(other).flashLoan(poolId, token0.target, 100, "0x"),
    )
      .to.be.revertedWithCustomError(pool, "InvalidFlashLoanReceiver")
      .withArgs(other.address);
  });

  it("fails closed when recorded reserves exceed the real token balance", async function () {
    const { pool, poolId, receiver, token0, liquidity } =
      await loadFixture(deployFixture);
    await token0.burn(pool.target, 1);

    await expect(receiver.requestFlashLoan(poolId, token0.target, 100, "0x"))
      .to.be.revertedWithCustomError(pool, "InsufficientLiquidity")
      .withArgs(liquidity, liquidity - 1n);
  });
});
