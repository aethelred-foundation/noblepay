import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("PaymentChannels", function () {
  async function deployFixture() {
    const [admin, partyA, partyB, partyC, router, watchtowerOp, treasury, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const PC = await ethers.getContractFactory("PaymentChannels");
    const pc = await PC.deploy(admin.address, treasury.address, 100); // 1% protocol fee

    // Setup token
    await pc.connect(admin).setSupportedToken(usdc.target, true);

    // KYC verify parties
    await pc.connect(admin).setKYCStatus(partyA.address, true);
    await pc.connect(admin).setKYCStatus(partyB.address, true);
    await pc.connect(admin).setKYCStatus(partyC.address, true);

    // Grant router role
    await pc.connect(admin).grantRole(await pc.ROUTER_ROLE(), router.address);

    // Mint tokens
    const mintAmount = ethers.parseUnits("10000000", 6);
    await usdc.mint(partyA.address, mintAmount);
    await usdc.mint(partyB.address, mintAmount);
    await usdc.mint(partyC.address, mintAmount);
    await usdc.connect(partyA).approve(pc.target, ethers.MaxUint256);
    await usdc.connect(partyB).approve(pc.target, ethers.MaxUint256);
    await usdc.connect(partyC).approve(pc.target, ethers.MaxUint256);

    return { pc, usdc, admin, partyA, partyB, partyC, router, watchtowerOp, treasury, other };
  }

  const DEPOSIT = ethers.parseUnits("10000", 6);
  const CHALLENGE_PERIOD = 24 * 3600; // 24 hours

  async function channelOpenedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { pc, usdc, partyA, partyB } = fixture;
    const tx = await pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened");
    const channelId = event.args[0];
    return { ...fixture, channelId };
  }

  async function channelActiveFixture() {
    const fixture = await channelOpenedFixture();
    const { pc, partyB, channelId } = fixture;
    // Party B funds to activate
    await pc.connect(partyB).fundChannel(channelId, DEPOSIT);
    return fixture;
  }

  // Helper: sign a state for cooperative close
  async function signCloseState(channelId, balanceA, balanceB, nonce, signer) {
    const stateHash = ethers.keccak256(
      ethers.solidityPacked(
        ["bytes32", "uint256", "uint256", "uint256", "string"],
        [channelId, balanceA, balanceB, nonce, "CLOSE"]
      )
    );
    return signer.signMessage(ethers.getBytes(stateHash));
  }

  // Helper: sign a state for unilateral close / dispute
  async function signState(channelId, balanceA, balanceB, nonce, signer) {
    const stateHash = ethers.keccak256(
      ethers.solidityPacked(
        ["bytes32", "uint256", "uint256", "uint256", "string"],
        [channelId, balanceA, balanceB, nonce, "STATE"]
      )
    );
    return signer.signMessage(ethers.getBytes(stateHash));
  }

  describe("Deployment", function () {
    it("should set admin, treasury and fee", async function () {
      const { pc, admin, treasury } = await loadFixture(deployFixture);
      const ADMIN_ROLE = await pc.ADMIN_ROLE();
      expect(await pc.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await pc.protocolTreasury()).to.equal(treasury.address);
      expect(await pc.protocolFeeBps()).to.equal(100);
    });

    it("should revert with zero admin", async function () {
      const PC = await ethers.getContractFactory("PaymentChannels");
      const [, t] = await ethers.getSigners();
      await expect(PC.deploy(ethers.ZeroAddress, t.address, 100))
        .to.be.revertedWithCustomError(PC, "ZeroAddress");
    });

    it("should revert with zero treasury", async function () {
      const PC = await ethers.getContractFactory("PaymentChannels");
      const [a] = await ethers.getSigners();
      await expect(PC.deploy(a.address, ethers.ZeroAddress, 100))
        .to.be.revertedWithCustomError(PC, "ZeroAddress");
    });

    it("should revert with excessive fee", async function () {
      const PC = await ethers.getContractFactory("PaymentChannels");
      const [a, t] = await ethers.getSigners();
      await expect(PC.deploy(a.address, t.address, 501))
        .to.be.revertedWithCustomError(PC, "InvalidFee");
    });
  });

  describe("Channel Opening", function () {
    it("should open a channel", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100))
        .to.emit(pc, "ChannelOpened");
    });

    it("should set channel in OPEN status", async function () {
      const { pc, channelId } = await channelOpenedFixture();
      const ch = await pc.getChannel(channelId);
      expect(ch.status).to.equal(0); // OPEN
    });

    it("should revert for non-KYC party", async function () {
      const { pc, usdc, partyA, other } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(other.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100))
        .to.be.revertedWithCustomError(pc, "KYCRequired");
    });

    it("should revert for unsupported token", async function () {
      const { pc, partyA, partyB, other } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyB.address, other.address, DEPOSIT, CHALLENGE_PERIOD, 100))
        .to.be.revertedWithCustomError(pc, "UnsupportedToken");
    });

    it("should revert for zero deposit", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyB.address, usdc.target, 0, CHALLENGE_PERIOD, 100))
        .to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert for challenge period too short", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, 60, 100))
        .to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert for challenge period too long", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, 8 * 86400, 100))
        .to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert for excessive routing fee", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 501))
        .to.be.revertedWithCustomError(pc, "InvalidFee");
    });

    it("should revert opening channel with self", async function () {
      const { pc, usdc, partyA } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).openChannel(partyA.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100))
        .to.be.revertedWithCustomError(pc, "ZeroAddress");
    });
  });

  describe("Channel Funding", function () {
    it("should fund channel as partyB", async function () {
      const { pc, partyB, channelId } = await channelOpenedFixture();
      await expect(pc.connect(partyB).fundChannel(channelId, DEPOSIT))
        .to.emit(pc, "ChannelFunded");
    });

    it("should activate channel when both funded", async function () {
      const { pc, partyB, channelId } = await channelOpenedFixture();
      await pc.connect(partyB).fundChannel(channelId, DEPOSIT);
      const ch = await pc.getChannel(channelId);
      expect(ch.status).to.equal(2); // ACTIVE
    });

    it("should revert fund with zero amount", async function () {
      const { pc, partyB, channelId } = await channelOpenedFixture();
      await expect(pc.connect(partyB).fundChannel(channelId, 0))
        .to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert fund by non-party", async function () {
      const { pc, other, channelId } = await channelOpenedFixture();
      await expect(pc.connect(other).fundChannel(channelId, DEPOSIT))
        .to.be.revertedWithCustomError(pc, "NotChannelParty");
    });

    it("should allow partyA to top up", async function () {
      const { pc, partyA, channelId } = await channelOpenedFixture();
      await expect(pc.connect(partyA).fundChannel(channelId, DEPOSIT))
        .to.emit(pc, "ChannelFunded");
    });
  });

  describe("Cooperative Close", function () {
    it("should cooperatively close a channel", async function () {
      const { pc, usdc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = ethers.parseUnits("12000", 6);
      const balB = ethers.parseUnits("8000", 6);
      const nonce = 1n;
      const sigA = await signCloseState(channelId, balA, balB, nonce, partyA);
      const sigB = await signCloseState(channelId, balA, balB, nonce, partyB);
      await expect(pc.connect(partyA).cooperativeClose(channelId, balA, balB, nonce, sigA, sigB))
        .to.emit(pc, "ChannelCooperativeClose");
    });

    it("should revert with invalid balances (sum != total deposit)", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = ethers.parseUnits("15000", 6);
      const balB = ethers.parseUnits("8000", 6); // sum != 20000
      const nonce = 1n;
      const sigA = await signCloseState(channelId, balA, balB, nonce, partyA);
      const sigB = await signCloseState(channelId, balA, balB, nonce, partyB);
      await expect(pc.connect(partyA).cooperativeClose(channelId, balA, balB, nonce, sigA, sigB))
        .to.be.revertedWithCustomError(pc, "InvalidBalances");
    });

    it("should revert with nonce too low", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 0n; // same as current
      const sigA = await signCloseState(channelId, balA, balB, nonce, partyA);
      const sigB = await signCloseState(channelId, balA, balB, nonce, partyB);
      await expect(pc.connect(partyA).cooperativeClose(channelId, balA, balB, nonce, sigA, sigB))
        .to.be.revertedWithCustomError(pc, "NonceTooLow");
    });

    it("should revert with invalid signature", async function () {
      const { pc, partyA, other, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigA = await signCloseState(channelId, balA, balB, nonce, partyA);
      const sigBad = await signCloseState(channelId, balA, balB, nonce, other); // wrong signer
      await expect(pc.connect(partyA).cooperativeClose(channelId, balA, balB, nonce, sigA, sigBad))
        .to.be.revertedWithCustomError(pc, "InvalidSignature");
    });
  });

  describe("Unilateral Close & Disputes", function () {
    it("should initiate unilateral close", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = ethers.parseUnits("12000", 6);
      const balB = ethers.parseUnits("8000", 6);
      const nonce = 1n;
      const sigB = await signState(channelId, balA, balB, nonce, partyB);
      await expect(pc.connect(partyA).initiateUnilateralClose(channelId, balA, balB, nonce, sigB))
        .to.emit(pc, "ChannelUnilateralClose")
        .to.emit(pc, "DisputeInitiated");
    });

    it("should set channel to CLOSING status", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigB = await signState(channelId, balA, balB, nonce, partyB);
      await pc.connect(partyA).initiateUnilateralClose(channelId, balA, balB, nonce, sigB);
      const ch = await pc.getChannel(channelId);
      expect(ch.status).to.equal(3); // CLOSING
    });

    it("should counter dispute with higher nonce", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      // partyA initiates unilateral close
      const balA = ethers.parseUnits("12000", 6);
      const balB = ethers.parseUnits("8000", 6);
      const nonce1 = 1n;
      const sigB1 = await signState(channelId, balA, balB, nonce1, partyB);
      await pc.connect(partyA).initiateUnilateralClose(channelId, balA, balB, nonce1, sigB1);

      // partyB counters with higher nonce
      const newBalA = ethers.parseUnits("9000", 6);
      const newBalB = ethers.parseUnits("11000", 6);
      const nonce2 = 2n;
      const sigA2 = await signState(channelId, newBalA, newBalB, nonce2, partyA);
      await expect(pc.connect(partyB).counterDispute(channelId, newBalA, newBalB, nonce2, sigA2))
        .to.emit(pc, "DisputeCountered");
    });

    it("should finalize close after challenge period", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigB = await signState(channelId, balA, balB, nonce, partyB);
      await pc.connect(partyA).initiateUnilateralClose(channelId, balA, balB, nonce, sigB);

      await time.increase(CHALLENGE_PERIOD + 1);

      await expect(pc.connect(partyA).finalizeClose(channelId))
        .to.emit(pc, "DisputeResolved")
        .to.emit(pc, "ChannelClosed");
    });

    it("should revert finalize before challenge expires", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigB = await signState(channelId, balA, balB, nonce, partyB);
      await pc.connect(partyA).initiateUnilateralClose(channelId, balA, balB, nonce, sigB);

      await expect(pc.connect(partyA).finalizeClose(channelId))
        .to.be.revertedWithCustomError(pc, "ChallengeNotExpired");
    });

    it("should revert counter dispute after challenge expires", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce1 = 1n;
      const sigB1 = await signState(channelId, balA, balB, nonce1, partyB);
      await pc.connect(partyA).initiateUnilateralClose(channelId, balA, balB, nonce1, sigB1);

      await time.increase(CHALLENGE_PERIOD + 1);

      const nonce2 = 2n;
      const sigA2 = await signState(channelId, balA, balB, nonce2, partyA);
      await expect(pc.connect(partyB).counterDispute(channelId, balA, balB, nonce2, sigA2))
        .to.be.revertedWithCustomError(pc, "ChallengePeriodExpired");
    });
  });

  describe("HTLC", function () {
    it("should create an HTLC", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.randomBytes(32);
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n; // 2 hours
      const amount = ethers.parseUnits("1000", 6);

      await expect(pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock))
        .to.emit(pc, "HTLCCreated");
    });

    it("should claim an HTLC with correct preimage", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      await expect(pc.connect(partyB).claimHTLC(htlcId, preimage))
        .to.emit(pc, "HTLCClaimed");
    });

    it("should revert claim with wrong preimage", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      const wrongPreimage = ethers.hexlify(ethers.randomBytes(32));
      await expect(pc.connect(partyB).claimHTLC(htlcId, wrongPreimage))
        .to.be.revertedWithCustomError(pc, "InvalidPreimage");
    });

    it("should refund an expired HTLC", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      await time.increaseTo(timelock + 1n);

      await expect(pc.connect(partyA).refundHTLC(htlcId))
        .to.emit(pc, "HTLCRefunded");
    });

    it("should revert refund before expiry", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      await expect(pc.connect(partyA).refundHTLC(htlcId))
        .to.be.revertedWithCustomError(pc, "HTLCNotExpired");
    });

    it("should revert claim after expiry", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "HTLCCreated");
      const htlcId = event.args[0];

      await time.increaseTo(timelock + 1n);

      await expect(pc.connect(partyB).claimHTLC(htlcId, preimage))
        .to.be.revertedWithCustomError(pc, "HTLCExpired");
    });

    it("should revert HTLC with zero amount", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [ethers.randomBytes(32)]));
      const timelock = BigInt(await time.latest()) + 7200n;
      await expect(pc.connect(partyA).createHTLC(channelId, 0, hashLock, timelock))
        .to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert HTLC with insufficient balance", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [ethers.randomBytes(32)]));
      const timelock = BigInt(await time.latest()) + 7200n;
      const tooMuch = ethers.parseUnits("20000", 6); // more than partyA's balance
      await expect(pc.connect(partyA).createHTLC(channelId, tooMuch, hashLock, timelock))
        .to.be.revertedWithCustomError(pc, "InsufficientDeposit");
    });

    it("should revert HTLC with timelock too short", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [ethers.randomBytes(32)]));
      const timelock = BigInt(await time.latest()) + 100n; // less than MIN_HTLC_TIMELOCK (1 hour)
      await expect(pc.connect(partyA).createHTLC(channelId, 1000, hashLock, timelock))
        .to.be.revertedWithCustomError(pc, "InvalidTimelock");
    });
  });

  describe("Watchtower", function () {
    it("should register a watchtower", async function () {
      const { pc, watchtowerOp } = await loadFixture(deployFixture);
      await expect(pc.connect(watchtowerOp).registerWatchtower(100, { value: ethers.parseEther("1") }))
        .to.emit(pc, "WatchtowerRegistered");
    });

    it("should revert with insufficient stake", async function () {
      const { pc, watchtowerOp } = await loadFixture(deployFixture);
      await expect(pc.connect(watchtowerOp).registerWatchtower(100, { value: ethers.parseEther("0.5") }))
        .to.be.revertedWithCustomError(pc, "InsufficientStake");
    });

    it("should revert duplicate registration", async function () {
      const { pc, watchtowerOp } = await loadFixture(deployFixture);
      await pc.connect(watchtowerOp).registerWatchtower(100, { value: ethers.parseEther("1") });
      await expect(pc.connect(watchtowerOp).registerWatchtower(100, { value: ethers.parseEther("1") }))
        .to.be.revertedWithCustomError(pc, "WatchtowerAlreadyRegistered");
    });

    it("should deregister and return stake", async function () {
      const { pc, watchtowerOp } = await loadFixture(deployFixture);
      await pc.connect(watchtowerOp).registerWatchtower(100, { value: ethers.parseEther("1") });
      await expect(pc.connect(watchtowerOp).deregisterWatchtower())
        .to.emit(pc, "WatchtowerDeregistered");
      const wt = await pc.getWatchtower(watchtowerOp.address);
      expect(wt.active).to.be.false;
    });

    it("should revert deregister for non-watchtower", async function () {
      const { pc, other } = await loadFixture(deployFixture);
      await expect(pc.connect(other).deregisterWatchtower())
        .to.be.revertedWithCustomError(pc, "WatchtowerNotFound");
    });

    it("should assign watchtower to channel", async function () {
      const { pc, partyA, watchtowerOp, channelId } = await channelOpenedFixture();
      await pc.connect(watchtowerOp).registerWatchtower(100, { value: ethers.parseEther("1") });
      await expect(pc.connect(partyA).assignWatchtower(channelId, watchtowerOp.address))
        .to.emit(pc, "WatchtowerAssigned");
    });
  });

  describe("Multi-Hop Routing", function () {
    it("should register a routing path", async function () {
      const { pc, usdc, partyA, partyB, partyC, router } = await loadFixture(deployFixture);
      // Open two channels: A-B, B-C
      const tx1 = await pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
      const r1 = await tx1.wait();
      const ch1 = r1.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened").args[0];
      await pc.connect(partyB).fundChannel(ch1, DEPOSIT);

      const tx2 = await pc.connect(partyB).openChannel(partyC.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
      const r2 = await tx2.wait();
      const ch2 = r2.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened").args[0];
      await pc.connect(partyC).fundChannel(ch2, DEPOSIT);

      const amount = ethers.parseUnits("1000", 6);
      await expect(pc.connect(router).registerRoutingPath([ch1, ch2], [partyB.address], amount))
        .to.emit(pc, "RoutingPathCreated");
    });

    it("should complete a routing path", async function () {
      const { pc, usdc, partyA, partyB, partyC, router } = await loadFixture(deployFixture);
      const tx1 = await pc.connect(partyA).openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
      const r1 = await tx1.wait();
      const ch1 = r1.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened").args[0];
      await pc.connect(partyB).fundChannel(ch1, DEPOSIT);

      const tx2 = await pc.connect(partyB).openChannel(partyC.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD, 100);
      const r2 = await tx2.wait();
      const ch2 = r2.logs.find(l => l.fragment && l.fragment.name === "ChannelOpened").args[0];
      await pc.connect(partyC).fundChannel(ch2, DEPOSIT);

      const amount = ethers.parseUnits("1000", 6);
      const ptx = await pc.connect(router).registerRoutingPath([ch1, ch2], [partyB.address], amount);
      const pr = await ptx.wait();
      const pathId = pr.logs.find(l => l.fragment && l.fragment.name === "RoutingPathCreated").args[0];

      await expect(pc.connect(router).completeRoutingPath(pathId))
        .to.emit(pc, "RoutingPathCompleted");
    });

    it("should revert too many hops", async function () {
      const { pc, router } = await loadFixture(deployFixture);
      const fakeIds = Array(6).fill(ethers.ZeroHash);
      const fakeIntermediaries = Array(5).fill(ethers.ZeroAddress);
      await expect(pc.connect(router).registerRoutingPath(fakeIds, fakeIntermediaries, 1000))
        .to.be.revertedWithCustomError(pc, "RoutingPathTooLong");
    });

    it("should revert for non-router", async function () {
      const { pc, other } = await loadFixture(deployFixture);
      await expect(pc.connect(other).registerRoutingPath([ethers.ZeroHash], [], 1000))
        .to.be.revert(ethers);
    });
  });

  describe("Batch Operations", function () {
    it("should batch open channels", async function () {
      const { pc, usdc, partyA, partyB, partyC } = await loadFixture(deployFixture);
      const dep = ethers.parseUnits("5000", 6);
      await expect(pc.connect(partyA).batchOpenChannels(
        [partyB.address, partyC.address], usdc.target, [dep, dep], CHALLENGE_PERIOD, 100
      )).to.emit(pc, "ChannelBatchOpened");
    });

    it("should revert empty batch", async function () {
      const { pc, usdc, partyA } = await loadFixture(deployFixture);
      await expect(pc.connect(partyA).batchOpenChannels([], usdc.target, [], CHALLENGE_PERIOD, 100))
        .to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert batch too large", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      const counterparties = Array(21).fill(partyB.address);
      const deposits = Array(21).fill(DEPOSIT);
      await expect(pc.connect(partyA).batchOpenChannels(counterparties, usdc.target, deposits, CHALLENGE_PERIOD, 100))
        .to.be.revertedWithCustomError(pc, "BatchTooLarge");
    });
  });

  describe("View Functions", function () {
    it("should return user channels", async function () {
      const { pc, partyA, channelId } = await channelOpenedFixture();
      const channels = await pc.getUserChannels(partyA.address);
      expect(channels.length).to.equal(1);
      expect(channels[0]).to.equal(channelId);
    });

    it("should return channel HTLCs", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
      const timelock = BigInt(await time.latest()) + 7200n;
      await pc.connect(partyA).createHTLC(channelId, ethers.parseUnits("1000", 6), hashLock, timelock);
      const htlcs = await pc.getChannelHTLCs(channelId);
      expect(htlcs.length).to.equal(1);
    });

    it("should compute state hash", async function () {
      const { pc, channelId } = await channelActiveFixture();
      const hash = await pc.computeStateHash(channelId, DEPOSIT, DEPOSIT, 1, "STATE");
      expect(hash).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Admin", function () {
    it("should set supported token", async function () {
      const { pc, admin, other } = await loadFixture(deployFixture);
      await expect(pc.connect(admin).setSupportedToken(other.address, true))
        .to.emit(pc, "TokenSupported");
    });

    it("should set KYC status", async function () {
      const { pc, admin, other } = await loadFixture(deployFixture);
      await expect(pc.connect(admin).setKYCStatus(other.address, true))
        .to.emit(pc, "KYCStatusUpdated");
    });

    it("should batch set KYC status", async function () {
      const { pc, admin, partyA, partyB } = await loadFixture(deployFixture);
      await pc.connect(admin).batchSetKYCStatus([partyA.address, partyB.address], [true, true]);
      expect(await pc.kycVerified(partyA.address)).to.be.true;
    });

    it("should set NoblePay contract", async function () {
      const { pc, admin, other } = await loadFixture(deployFixture);
      await pc.connect(admin).setNoblePayContract(other.address);
      expect(await pc.noblePayContract()).to.equal(other.address);
    });

    it("should pause and unpause", async function () {
      const { pc, admin } = await loadFixture(deployFixture);
      await pc.connect(admin).pause();
      expect(await pc.paused()).to.be.true;
      await pc.connect(admin).unpause();
      expect(await pc.paused()).to.be.false;
    });
  });
});
