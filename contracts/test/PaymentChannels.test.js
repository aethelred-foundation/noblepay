const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  signChannelState,
  hashChannelState,
} = require("./helpers/paymentChannels");

describe("PaymentChannels", function () {
  async function deployFixture() {
    const [admin, partyA, partyB, partyC, treasury, other] =
      await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const PC = await ethers.getContractFactory("PaymentChannels");
    const pc = await PC.deploy(admin.address, treasury.address, 100); // 1% protocol fee

    const Registry = await ethers.getContractFactory("MockBusinessRegistry");
    const registry = await Registry.deploy();
    await pc.connect(admin).configureBusinessRegistry(registry.target);

    // Setup token
    await pc.connect(admin).setSupportedToken(usdc.target, true);

    // Configure current BusinessRegistry state for channel parties.
    await registry.setBusiness(partyA.address, true, 0);
    await registry.setBusiness(partyB.address, true, 0);
    await registry.setBusiness(partyC.address, true, 0);

    // Mint tokens
    const mintAmount = ethers.parseUnits("10000000", 6);
    await usdc.mint(partyA.address, mintAmount);
    await usdc.mint(partyB.address, mintAmount);
    await usdc.mint(partyC.address, mintAmount);
    await usdc.connect(partyA).approve(pc.target, ethers.MaxUint256);
    await usdc.connect(partyB).approve(pc.target, ethers.MaxUint256);
    await usdc.connect(partyC).approve(pc.target, ethers.MaxUint256);

    return {
      pc,
      registry,
      usdc,
      admin,
      partyA,
      partyB,
      partyC,
      treasury,
      other,
    };
  }

  const DEPOSIT = ethers.parseUnits("10000", 6);
  const CHALLENGE_PERIOD = 24 * 3600; // 24 hours

  async function liveRegistryFixture() {
    const [admin, partyA, partyB, treasury, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("BusinessRegistry");
    const registry = await Registry.deploy(admin.address);
    await registry
      .connect(partyA)
      .registerBusiness("UAE-A-1001", "Party A LLC", 0, partyA.address);
    await registry
      .connect(partyB)
      .registerBusiness("UAE-B-1002", "Party B LLC", 0, partyB.address);
    await registry.connect(admin).verifyBusiness(partyA.address);
    await registry.connect(admin).verifyBusiness(partyB.address);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);
    const PC = await ethers.getContractFactory("PaymentChannels");
    const pc = await PC.deploy(admin.address, treasury.address, 100);
    await pc.connect(admin).configureBusinessRegistry(registry.target);
    await pc.connect(admin).setSupportedToken(usdc.target, true);

    for (const party of [partyA, partyB]) {
      await usdc.mint(party.address, DEPOSIT * 10n);
      await usdc.connect(party).approve(pc.target, ethers.MaxUint256);
    }

    return { pc, registry, usdc, admin, partyA, partyB, treasury, other };
  }

  async function liveRegistryOpenedFixture() {
    const fixture = await loadFixture(liveRegistryFixture);
    const { pc, usdc, partyA, partyB } = fixture;
    const tx = await pc
      .connect(partyA)
      .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD);
    const receipt = await tx.wait();
    const channelId = receipt.logs.find(
      (log) => log.fragment?.name === "ChannelOpened",
    ).args.channelId;
    return { ...fixture, channelId };
  }

  async function liveRegistryActiveFixture() {
    const fixture = await liveRegistryOpenedFixture();
    await fixture.pc
      .connect(fixture.partyB)
      .fundChannel(fixture.channelId, DEPOSIT);
    return fixture;
  }

  async function channelOpenedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { pc, usdc, partyA, partyB } = fixture;
    const tx = await pc
      .connect(partyA)
      .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD);
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (l) => l.fragment && l.fragment.name === "ChannelOpened",
    );
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
  async function signCloseState(
    pc,
    channelId,
    balanceA,
    balanceB,
    nonce,
    signer,
  ) {
    return signChannelState(
      pc,
      signer,
      channelId,
      balanceA,
      balanceB,
      nonce,
      "CLOSE",
    );
  }

  // Helper: sign a state for unilateral close / dispute
  async function signState(pc, channelId, balanceA, balanceB, nonce, signer) {
    return signChannelState(
      pc,
      signer,
      channelId,
      balanceA,
      balanceB,
      nonce,
      "STATE",
    );
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
      await expect(
        PC.deploy(ethers.ZeroAddress, t.address, 100),
      ).to.be.revertedWithCustomError(PC, "ZeroAddress");
    });

    it("should revert with zero treasury", async function () {
      const PC = await ethers.getContractFactory("PaymentChannels");
      const [a] = await ethers.getSigners();
      await expect(
        PC.deploy(a.address, ethers.ZeroAddress, 100),
      ).to.be.revertedWithCustomError(PC, "ZeroAddress");
    });

    it("should revert with excessive fee", async function () {
      const PC = await ethers.getContractFactory("PaymentChannels");
      const [a, t] = await ethers.getSigners();
      await expect(
        PC.deploy(a.address, t.address, 501),
      ).to.be.revertedWithCustomError(PC, "InvalidFee");
    });
  });

  describe("Channel Opening", function () {
    it("should open a channel", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD),
      ).to.emit(pc, "ChannelOpened");
    });

    it("domain-separates channel identifiers by chain and contract deployment", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      const nonce = await pc.channelNonce();
      const tx = await pc
        .connect(partyA)
        .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const network = await ethers.provider.getNetwork();
      const event = receipt.logs.find(
        (log) => log.fragment?.name === "ChannelOpened",
      );
      const expected = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          [
            "uint256",
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
          ],
          [
            network.chainId,
            pc.target,
            partyA.address,
            partyB.address,
            usdc.target,
            block.timestamp,
            nonce,
          ],
        ),
      );
      expect(event.args.channelId).to.equal(expected);
    });

    it("should set channel in OPEN status", async function () {
      const { pc, channelId } = await channelOpenedFixture();
      const ch = await pc.getChannel(channelId);
      expect(ch.status).to.equal(0); // OPEN
    });

    it("should revert for non-KYC party", async function () {
      const { pc, usdc, partyA, other } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(other.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");
    });

    it("should revert for unsupported token", async function () {
      const { pc, partyA, partyB, other } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(
            partyB.address,
            other.address,
            DEPOSIT,
            CHALLENGE_PERIOD,
          ),
      ).to.be.revertedWithCustomError(pc, "UnsupportedToken");
    });

    it("should revert for zero deposit", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(partyB.address, usdc.target, 0, CHALLENGE_PERIOD),
      ).to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert for challenge period too short", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(partyB.address, usdc.target, DEPOSIT, 60),
      ).to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert for challenge period too long", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(partyB.address, usdc.target, DEPOSIT, 8 * 86400),
      ).to.be.revertedWithCustomError(pc, "InvalidChallengePeriod");
    });

    it("should revert opening channel with self", async function () {
      const { pc, usdc, partyA } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .openChannel(partyA.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD),
      ).to.be.revertedWithCustomError(pc, "ZeroAddress");
    });
  });

  describe("Channel Funding", function () {
    it("should fund channel as partyB", async function () {
      const { pc, partyB, channelId } = await channelOpenedFixture();
      await expect(pc.connect(partyB).fundChannel(channelId, DEPOSIT)).to.emit(
        pc,
        "ChannelFunded",
      );
    });

    it("should activate channel when both funded", async function () {
      const { pc, partyB, channelId } = await channelOpenedFixture();
      await pc.connect(partyB).fundChannel(channelId, DEPOSIT);
      const ch = await pc.getChannel(channelId);
      expect(ch.status).to.equal(2); // ACTIVE
    });

    it("should revert fund with zero amount", async function () {
      const { pc, partyB, channelId } = await channelOpenedFixture();
      await expect(
        pc.connect(partyB).fundChannel(channelId, 0),
      ).to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert fund by non-party", async function () {
      const { pc, other, channelId } = await channelOpenedFixture();
      await expect(
        pc.connect(other).fundChannel(channelId, DEPOSIT),
      ).to.be.revertedWithCustomError(pc, "NotChannelParty");
    });

    it("should allow partyA to top up", async function () {
      const { pc, partyA, channelId } = await channelOpenedFixture();
      await expect(pc.connect(partyA).fundChannel(channelId, DEPOSIT)).to.emit(
        pc,
        "ChannelFunded",
      );
      const channel = await pc.getChannel(channelId);
      expect(channel.depositA).to.equal(DEPOSIT * 2n);
      expect(channel.stateEpoch).to.equal(1n);
    });

    it("invalidates future-nonce states signed before a channel top-up", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const topUp = ethers.parseUnits("2500", 6);
      const anticipatedBalanceA = DEPOSIT + topUp;

      const beforeTopUp = await pc.getChannel(channelId);
      expect(beforeTopUp.stateEpoch).to.equal(1n);

      // This state only becomes balance-valid after the future top-up: it already
      // allocates funds that are not escrowed yet and uses a far-future nonce.
      const preFundingSignature = await signState(
        pc,
        channelId,
        anticipatedBalanceA,
        DEPOSIT,
        100n,
        partyB,
      );

      // Party B then supplies the anticipated top-up. Without epoch binding,
      // party A could use the old signature to take that newly escrowed amount.
      await pc.connect(partyB).fundChannel(channelId, topUp);
      const funded = await pc.getChannel(channelId);
      expect(funded.depositB).to.equal(anticipatedBalanceA);
      expect(funded.balanceB).to.equal(anticipatedBalanceA);
      expect(funded.stateEpoch).to.equal(2n);

      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            anticipatedBalanceA,
            DEPOSIT,
            100n,
            preFundingSignature,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");

      const currentSignature = await signState(
        pc,
        channelId,
        anticipatedBalanceA,
        DEPOSIT,
        101n,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            anticipatedBalanceA,
            DEPOSIT,
            101n,
            currentSignature,
          ),
      ).to.emit(pc, "ChannelUnilateralClose");
    });
  });

  describe("Live BusinessRegistry enforcement", function () {
    it("fails closed before configuration and rechecks single and batch channel opens", async function () {
      const { admin, partyA, partyB, treasury, other } =
        await loadFixture(liveRegistryFixture);
      const PC = await ethers.getContractFactory("PaymentChannels");
      const unconfigured = await PC.deploy(
        admin.address,
        treasury.address,
        100,
      );
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      await unconfigured.connect(admin).setSupportedToken(token.target, true);
      await token.mint(partyA.address, DEPOSIT * 2n);
      await token.connect(partyA).approve(unconfigured.target, DEPOSIT * 2n);

      await expect(
        unconfigured
          .connect(partyA)
          .openChannel(partyB.address, token.target, DEPOSIT, CHALLENGE_PERIOD),
      ).to.be.revertedWithCustomError(unconfigured, "KYCRequired");
      expect(await unconfigured.kycVerified(other.address)).to.be.false;

      const { pc, registry, usdc } = await loadFixture(liveRegistryFixture);
      await registry
        .connect(admin)
        .suspendBusiness(partyB.address, "adversarial test");
      expect(await pc.kycVerified(partyB.address)).to.be.false;

      await expect(
        pc
          .connect(partyA)
          .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");
      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address],
            usdc.target,
            [DEPOSIT],
            CHALLENGE_PERIOD,
          ),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");

      await registry.connect(admin).reinstateBusiness(partyB.address);
      await expect(
        pc
          .connect(partyA)
          .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD),
      ).to.emit(pc, "ChannelOpened");
    });

    it("denies funding and HTLC creation after suspension while allowing cooperative exit", async function () {
      const { pc, registry, admin, partyA, partyB, channelId } =
        await liveRegistryActiveFixture();
      await registry
        .connect(admin)
        .suspendBusiness(partyA.address, "risk review");

      await expect(
        pc.connect(partyB).fundChannel(channelId, DEPOSIT),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");
      await expect(
        pc
          .connect(partyB)
          .createHTLC(
            channelId,
            1n,
            ethers.id("blocked-after-suspension"),
            BigInt(await time.latest()) + 7200n,
          ),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");

      const sigA = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        partyA,
      );
      const sigB = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, DEPOSIT, DEPOSIT, 1n, sigA, sigB),
      ).to.emit(pc, "ChannelCooperativeClose");
    });

    it("denies new exposure after revocation but still permits an in-flight HTLC claim", async function () {
      const { pc, registry, admin, partyA, partyB, channelId } =
        await liveRegistryActiveFixture();
      const preimage = ethers.id("revocation-does-not-trap-escrow");
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const amount = ethers.parseUnits("500", 6);
      const createTx = await pc
        .connect(partyA)
        .createHTLC(
          channelId,
          amount,
          hashLock,
          BigInt(await time.latest()) + 7200n,
        );
      const createReceipt = await createTx.wait();
      const htlcId = createReceipt.logs.find(
        (log) => log.fragment?.name === "HTLCCreated",
      ).args.htlcId;

      await registry
        .connect(admin)
        .revokeBusiness(partyB.address, "confirmed sanctions match");
      expect(await pc.kycVerified(partyB.address)).to.be.false;
      await expect(
        pc.connect(partyA).fundChannel(channelId, 1n),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");
      await expect(
        pc
          .connect(partyA)
          .createHTLC(
            channelId,
            1n,
            ethers.id("no-new-exposure"),
            BigInt(await time.latest()) + 7200n,
          ),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");

      await expect(pc.connect(partyB).claimHTLC(htlcId, preimage)).to.emit(
        pc,
        "HTLCClaimed",
      );
      expect((await pc.getChannel(channelId)).balanceB).to.equal(
        DEPOSIT + amount,
      );
    });

    it("denies new exposure after KYC expiry while preserving refund and dispute settlement", async function () {
      const { pc, registry, partyA, partyB, channelId } =
        await liveRegistryActiveFixture();
      const preimage = ethers.id("expired-kyc-refund");
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const amount = ethers.parseUnits("250", 6);
      const createTx = await pc
        .connect(partyA)
        .createHTLC(
          channelId,
          amount,
          hashLock,
          BigInt(await time.latest()) + 7200n,
        );
      const createReceipt = await createTx.wait();
      const htlcId = createReceipt.logs.find(
        (log) => log.fragment?.name === "HTLCCreated",
      ).args.htlcId;

      const interval = await registry.REVERIFICATION_INTERVAL();
      await time.increase(interval + 1n);
      expect(await pc.kycVerified(partyA.address)).to.be.false;
      expect(await pc.kycVerified(partyB.address)).to.be.false;

      await expect(
        pc.connect(partyB).fundChannel(channelId, 1n),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");
      await expect(
        pc
          .connect(partyA)
          .createHTLC(
            channelId,
            1n,
            ethers.id("expired-kyc-new-htlc"),
            BigInt(await time.latest()) + 7200n,
          ),
      ).to.be.revertedWithCustomError(pc, "KYCRequired");

      await expect(pc.connect(partyA).refundHTLC(htlcId)).to.emit(
        pc,
        "HTLCRefunded",
      );
      const closeSig = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(channelId, DEPOSIT, DEPOSIT, 1n, closeSig),
      ).to.emit(pc, "DisputeInitiated");

      const counterSig = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        2n,
        partyA,
      );
      await expect(
        pc
          .connect(partyB)
          .counterDispute(channelId, DEPOSIT, DEPOSIT, 2n, counterSig),
      ).to.emit(pc, "DisputeCountered");

      await time.increase(CHALLENGE_PERIOD);
      await expect(pc.finalizeClose(channelId)).to.emit(pc, "DisputeResolved");
    });
  });

  describe("Exact Escrow Accounting", function () {
    async function feeTokenFixture() {
      const [admin, partyA, partyB, partyC, treasury] =
        await ethers.getSigners();
      const FeeToken = await ethers.getContractFactory(
        "MockFeeOnTransferERC20",
      );
      const feeToken = await FeeToken.deploy();
      const PC = await ethers.getContractFactory("PaymentChannels");
      const pc = await PC.deploy(admin.address, treasury.address, 100);

      const Registry = await ethers.getContractFactory("MockBusinessRegistry");
      const registry = await Registry.deploy();
      await pc.connect(admin).configureBusinessRegistry(registry.target);

      await pc.connect(admin).setSupportedToken(feeToken.target, true);
      for (const party of [partyA, partyB, partyC]) {
        await registry.setBusiness(party.address, true, 0);
        await feeToken.mint(party.address, DEPOSIT * 10n);
        await feeToken.connect(party).approve(pc.target, ethers.MaxUint256);
      }
      return { pc, registry, feeToken, admin, partyA, partyB, partyC };
    }

    it("rejects an underfunded initial escrow from a fee-on-transfer token", async function () {
      const { pc, feeToken, partyA, partyB } =
        await loadFixture(feeTokenFixture);
      await feeToken.setFeeBps(100);
      const received = (DEPOSIT * 9_900n) / 10_000n;

      await expect(
        pc
          .connect(partyA)
          .openChannel(
            partyB.address,
            feeToken.target,
            DEPOSIT,
            CHALLENGE_PERIOD,
          ),
      )
        .to.be.revertedWithCustomError(pc, "EscrowTransferMismatch")
        .withArgs(DEPOSIT, received);
      expect(await pc.channelNonce()).to.equal(0);
    });

    it("rejects an underfunded channel top-up and rolls back accounting", async function () {
      const { pc, feeToken, partyA, partyB } =
        await loadFixture(feeTokenFixture);
      const openTx = await pc
        .connect(partyA)
        .openChannel(
          partyB.address,
          feeToken.target,
          DEPOSIT,
          CHALLENGE_PERIOD,
        );
      const receipt = await openTx.wait();
      const channelId = receipt.logs.find(
        (log) => log.fragment?.name === "ChannelOpened",
      ).args.channelId;
      await feeToken.setFeeBps(100);

      await expect(
        pc.connect(partyB).fundChannel(channelId, DEPOSIT),
      ).to.be.revertedWithCustomError(pc, "EscrowTransferMismatch");
      const channel = await pc.getChannel(channelId);
      expect(channel.depositB).to.equal(0);
      expect(channel.balanceB).to.equal(0);
      expect(channel.stateEpoch).to.equal(0);
      expect(channel.status).to.equal(0);
    });

    it("rejects an underfunded batch escrow atomically", async function () {
      const { pc, feeToken, partyA, partyB, partyC } =
        await loadFixture(feeTokenFixture);
      await feeToken.setFeeBps(100);

      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, partyC.address],
            feeToken.target,
            [DEPOSIT, DEPOSIT],
            CHALLENGE_PERIOD,
          ),
      ).to.be.revertedWithCustomError(pc, "EscrowTransferMismatch");
      expect(await pc.channelNonce()).to.equal(0);
      expect(await pc.getUserChannels(partyA.address)).to.deep.equal([]);
    });

    it("rejects a negative-rebase balance delta during channel funding", async function () {
      const [admin, partyA, partyB, treasury] = await ethers.getSigners();
      const Token = await ethers.getContractFactory(
        "MockBalanceShrinkingERC20",
      );
      const token = await Token.deploy();
      const PC = await ethers.getContractFactory("PaymentChannels");
      const pc = await PC.deploy(admin.address, treasury.address, 0);
      const Registry = await ethers.getContractFactory("MockBusinessRegistry");
      const registry = await Registry.deploy();
      await pc.connect(admin).configureBusinessRegistry(registry.target);
      await pc.connect(admin).setSupportedToken(token.target, true);
      await registry.setBusiness(partyA.address, true, 0);
      await registry.setBusiness(partyB.address, true, 0);
      await token.mint(partyA.address, DEPOSIT);
      await token.mint(partyB.address, DEPOSIT);
      await token.connect(partyA).approve(pc.target, DEPOSIT);
      await token.connect(partyB).approve(pc.target, DEPOSIT);
      const openTx = await pc
        .connect(partyA)
        .openChannel(partyB.address, token.target, DEPOSIT, CHALLENGE_PERIOD);
      const receipt = await openTx.wait();
      const channelId = receipt.logs.find(
        (log) => log.fragment?.name === "ChannelOpened",
      ).args.channelId;
      await token.setRecipientShrinkBps(10_000);

      await expect(pc.connect(partyB).fundChannel(channelId, DEPOSIT))
        .to.be.revertedWithCustomError(pc, "EscrowTransferMismatch")
        .withArgs(DEPOSIT, 0);
      expect(await token.balanceOf(pc.target)).to.equal(DEPOSIT);
      expect((await pc.getChannel(channelId)).depositB).to.equal(0);
    });
  });

  describe("Cooperative Close", function () {
    it("should cooperatively close a channel", async function () {
      const { pc, usdc, partyA, partyB, channelId } =
        await channelActiveFixture();
      const balA = ethers.parseUnits("12000", 6);
      const balB = ethers.parseUnits("8000", 6);
      const nonce = 1n;
      const sigA = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyA,
      );
      const sigB = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, balA, balB, nonce, sigA, sigB),
      ).to.emit(pc, "ChannelCooperativeClose");
    });

    it("supports an ERC-1271 business wallet without weakening signature checks", async function () {
      const { pc, registry, usdc, partyA, partyB, other } =
        await loadFixture(deployFixture);
      const Wallet = await ethers.getContractFactory("MockERC1271Wallet");
      const contractWallet = await Wallet.deploy(partyB.address);
      await registry.setBusiness(contractWallet.target, true, 0);
      await usdc.mint(contractWallet.target, DEPOSIT);

      const openTx = await pc
        .connect(partyA)
        .openChannel(
          contractWallet.target,
          usdc.target,
          DEPOSIT,
          CHALLENGE_PERIOD,
        );
      const receipt = await openTx.wait();
      const channelId = receipt.logs.find(
        (log) => log.fragment?.name === "ChannelOpened",
      ).args.channelId;

      await contractWallet
        .connect(partyB)
        .execute(
          usdc.target,
          usdc.interface.encodeFunctionData("approve", [pc.target, DEPOSIT]),
        );
      await contractWallet
        .connect(partyB)
        .execute(
          pc.target,
          pc.interface.encodeFunctionData("fundChannel", [channelId, DEPOSIT]),
        );

      const sigA = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        partyA,
      );
      const contractSignature = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        partyB,
      );
      const wrongContractSignature = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        other,
      );

      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            1n,
            sigA,
            wrongContractSignature,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");

      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            1n,
            sigA,
            contractSignature,
          ),
      ).to.emit(pc, "ChannelCooperativeClose");
    });

    it("should revert with invalid balances (sum != total deposit)", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = ethers.parseUnits("15000", 6);
      const balB = ethers.parseUnits("8000", 6); // sum != 20000
      const nonce = 1n;
      const sigA = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyA,
      );
      const sigB = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, balA, balB, nonce, sigA, sigB),
      ).to.be.revertedWithCustomError(pc, "InvalidBalances");
    });

    it("should revert with nonce too low", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 0n; // same as current
      const sigA = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyA,
      );
      const sigB = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, balA, balB, nonce, sigA, sigB),
      ).to.be.revertedWithCustomError(pc, "NonceTooLow");
    });

    it("should revert with invalid signature", async function () {
      const { pc, partyA, other, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigA = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        partyA,
      );
      const sigBad = await signCloseState(
        pc,
        channelId,
        balA,
        balB,
        nonce,
        other,
      ); // wrong signer
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, balA, balB, nonce, sigA, sigBad),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");
    });

    it("rejects a typed close signature created for another chain", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const sigA = await signChannelState(
        pc,
        partyA,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        "CLOSE",
        { chainId: chainId + 1n },
      );
      const sigB = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyB,
      );

      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, DEPOSIT, DEPOSIT, 1, sigA, sigB),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");
    });

    it("rejects a typed close signature created for another deployment", async function () {
      const { pc, registry, usdc, admin, treasury, partyA, partyB } =
        await loadFixture(deployFixture);
      const PC = await ethers.getContractFactory("PaymentChannels");
      const otherDeployment = await PC.deploy(
        admin.address,
        treasury.address,
        100,
      );
      await otherDeployment
        .connect(admin)
        .configureBusinessRegistry(registry.target);
      await otherDeployment.connect(admin).setSupportedToken(usdc.target, true);
      await usdc
        .connect(partyA)
        .approve(otherDeployment.target, ethers.MaxUint256);
      await usdc
        .connect(partyB)
        .approve(otherDeployment.target, ethers.MaxUint256);
      const openTx = await otherDeployment
        .connect(partyA)
        .openChannel(partyB.address, usdc.target, DEPOSIT, CHALLENGE_PERIOD);
      const receipt = await openTx.wait();
      const channelId = receipt.logs.find(
        (log) => log.fragment?.name === "ChannelOpened",
      ).args.channelId;
      await otherDeployment.connect(partyB).fundChannel(channelId, DEPOSIT);

      const sigA = await signChannelState(
        otherDeployment,
        partyA,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        "CLOSE",
        { verifyingContract: pc.target },
      );
      const sigB = await signCloseState(
        otherDeployment,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyB,
      );
      await expect(
        otherDeployment
          .connect(partyA)
          .cooperativeClose(channelId, DEPOSIT, DEPOSIT, 1, sigA, sigB),
      ).to.be.revertedWithCustomError(otherDeployment, "InvalidSignature");
    });
  });

  describe("Unilateral Close & Disputes", function () {
    it("should initiate unilateral close", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = ethers.parseUnits("12000", 6);
      const balB = ethers.parseUnits("8000", 6);
      const nonce = 1n;
      const sigB = await signState(pc, channelId, balA, balB, nonce, partyB);
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(channelId, balA, balB, nonce, sigB),
      )
        .to.emit(pc, "ChannelUnilateralClose")
        .to.emit(pc, "DisputeInitiated");
    });

    it("should set channel to CLOSING status", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigB = await signState(pc, channelId, balA, balB, nonce, partyB);
      await pc
        .connect(partyA)
        .initiateUnilateralClose(channelId, balA, balB, nonce, sigB);
      const ch = await pc.getChannel(channelId);
      expect(ch.status).to.equal(3); // CLOSING
    });

    it("should counter dispute with higher nonce", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      // partyA initiates unilateral close
      const balA = ethers.parseUnits("12000", 6);
      const balB = ethers.parseUnits("8000", 6);
      const nonce1 = 1n;
      const sigB1 = await signState(pc, channelId, balA, balB, nonce1, partyB);
      await pc
        .connect(partyA)
        .initiateUnilateralClose(channelId, balA, balB, nonce1, sigB1);

      // partyB counters with higher nonce
      const newBalA = ethers.parseUnits("9000", 6);
      const newBalB = ethers.parseUnits("11000", 6);
      const nonce2 = 2n;
      const sigA2 = await signState(
        pc,
        channelId,
        newBalA,
        newBalB,
        nonce2,
        partyA,
      );
      await expect(
        pc
          .connect(partyB)
          .counterDispute(channelId, newBalA, newBalB, nonce2, sigA2),
      ).to.emit(pc, "DisputeCountered");
    });

    it("keeps the counter-dispute remedy available during an emergency pause", async function () {
      const { pc, admin, partyA, partyB, channelId } =
        await channelActiveFixture();
      const staleBalanceA = ethers.parseUnits("8000", 6);
      const staleBalanceB = ethers.parseUnits("12000", 6);
      const staleSignature = await signState(
        pc,
        channelId,
        staleBalanceA,
        staleBalanceB,
        1n,
        partyB,
      );
      await pc
        .connect(partyA)
        .initiateUnilateralClose(
          channelId,
          staleBalanceA,
          staleBalanceB,
          1n,
          staleSignature,
        );

      const currentBalanceA = ethers.parseUnits("9000", 6);
      const currentBalanceB = ethers.parseUnits("11000", 6);
      const currentSignature = await signState(
        pc,
        channelId,
        currentBalanceA,
        currentBalanceB,
        2n,
        partyA,
      );
      await pc.connect(admin).pause();

      await expect(
        pc
          .connect(partyB)
          .counterDispute(
            channelId,
            currentBalanceA,
            currentBalanceB,
            2n,
            currentSignature,
          ),
      ).to.emit(pc, "DisputeCountered");
      expect((await pc.getDispute(channelId)).challengeNonce).to.equal(2n);
    });

    it("should finalize close after challenge period", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce = 1n;
      const sigB = await signState(pc, channelId, balA, balB, nonce, partyB);
      await pc
        .connect(partyA)
        .initiateUnilateralClose(channelId, balA, balB, nonce, sigB);

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
      const sigB = await signState(pc, channelId, balA, balB, nonce, partyB);
      await pc
        .connect(partyA)
        .initiateUnilateralClose(channelId, balA, balB, nonce, sigB);

      await expect(
        pc.connect(partyA).finalizeClose(channelId),
      ).to.be.revertedWithCustomError(pc, "ChallengeNotExpired");
    });

    it("should revert counter dispute after challenge expires", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const balA = DEPOSIT;
      const balB = DEPOSIT;
      const nonce1 = 1n;
      const sigB1 = await signState(pc, channelId, balA, balB, nonce1, partyB);
      await pc
        .connect(partyA)
        .initiateUnilateralClose(channelId, balA, balB, nonce1, sigB1);

      await time.increase(CHALLENGE_PERIOD + 1);

      const nonce2 = 2n;
      const sigA2 = await signState(pc, channelId, balA, balB, nonce2, partyA);
      await expect(
        pc.connect(partyB).counterDispute(channelId, balA, balB, nonce2, sigA2),
      ).to.be.revertedWithCustomError(pc, "ChallengePeriodExpired");
    });
  });

  describe("HTLC", function () {
    it("should create an HTLC", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.randomBytes(32);
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n; // 2 hours
      const amount = ethers.parseUnits("1000", 6);

      await expect(
        pc.connect(partyA).createHTLC(channelId, amount, hashLock, timelock),
      ).to.emit(pc, "HTLCCreated");
    });

    it("should claim an HTLC with correct preimage", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "HTLCCreated",
      );
      const htlcId = event.args[0];

      await expect(pc.connect(partyB).claimHTLC(htlcId, preimage)).to.emit(
        pc,
        "HTLCClaimed",
      );
      expect(await pc.activeHTLCLockedAmount(channelId)).to.equal(0);

      const sigA = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyA,
      );
      const sigB = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(channelId, DEPOSIT, DEPOSIT, 1, sigA, sigB),
      ).to.emit(pc, "ChannelClosed");
    });

    it("keeps a preimage claim available while paused", async function () {
      const { pc, admin, partyA, partyB, channelId } =
        await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const tx = await pc
        .connect(partyA)
        .createHTLC(
          channelId,
          ethers.parseUnits("1000", 6),
          hashLock,
          timelock,
        );
      const receipt = await tx.wait();
      const htlcId = receipt.logs.find(
        (log) => log.fragment?.name === "HTLCCreated",
      ).args.htlcId;
      await pc.connect(admin).pause();

      await expect(pc.connect(partyB).claimHTLC(htlcId, preimage)).to.emit(
        pc,
        "HTLCClaimed",
      );
    });

    it("rejects future-nonce states signed before a claimed HTLC changes balances", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const preHTLCSignature = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        100n,
        partyB,
      );
      const createTx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const createReceipt = await createTx.wait();
      const htlcId = createReceipt.logs.find(
        (log) => log.fragment?.name === "HTLCCreated",
      ).args.htlcId;
      expect((await pc.getChannel(channelId)).stateEpoch).to.equal(2n);

      const inFlightSignature = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        101n,
        partyB,
      );
      await pc.connect(partyB).claimHTLC(htlcId, preimage);
      const claimed = await pc.getChannel(channelId);
      expect(claimed.stateEpoch).to.equal(3n);
      expect(claimed.balanceA).to.equal(DEPOSIT - amount);
      expect(claimed.balanceB).to.equal(DEPOSIT + amount);

      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            100n,
            preHTLCSignature,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            101n,
            inFlightSignature,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");

      const currentSignature = await signState(
        pc,
        channelId,
        DEPOSIT - amount,
        DEPOSIT + amount,
        102n,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            DEPOSIT - amount,
            DEPOSIT + amount,
            102n,
            currentSignature,
          ),
      ).to.emit(pc, "ChannelUnilateralClose");
    });

    it("should revert claim with wrong preimage", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "HTLCCreated",
      );
      const htlcId = event.args[0];

      const wrongPreimage = ethers.hexlify(ethers.randomBytes(32));
      await expect(
        pc.connect(partyB).claimHTLC(htlcId, wrongPreimage),
      ).to.be.revertedWithCustomError(pc, "InvalidPreimage");
    });

    it("should refund an expired HTLC", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "HTLCCreated",
      );
      const htlcId = event.args[0];

      await time.increaseTo(timelock + 1n);

      await expect(pc.connect(partyA).refundHTLC(htlcId)).to.emit(
        pc,
        "HTLCRefunded",
      );
      expect(await pc.activeHTLCLockedAmount(channelId)).to.equal(0);
    });

    it("keeps an expired HTLC refund available while paused", async function () {
      const { pc, admin, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const tx = await pc
        .connect(partyA)
        .createHTLC(
          channelId,
          ethers.parseUnits("1000", 6),
          hashLock,
          timelock,
        );
      const receipt = await tx.wait();
      const htlcId = receipt.logs.find(
        (log) => log.fragment?.name === "HTLCCreated",
      ).args.htlcId;
      await time.increaseTo(timelock + 1n);
      await pc.connect(admin).pause();

      await expect(pc.connect(partyA).refundHTLC(htlcId)).to.emit(
        pc,
        "HTLCRefunded",
      );
    });

    it("invalidates states signed while an HTLC is active after refund", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);
      const createTx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const createReceipt = await createTx.wait();
      const htlcId = createReceipt.logs.find(
        (log) => log.fragment?.name === "HTLCCreated",
      ).args.htlcId;
      const activeEpochSignature = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        200n,
        partyB,
      );

      await time.increaseTo(timelock + 1n);
      await pc.connect(partyA).refundHTLC(htlcId);
      const refunded = await pc.getChannel(channelId);
      expect(refunded.stateEpoch).to.equal(3n);
      expect(refunded.balanceA).to.equal(DEPOSIT);
      expect(refunded.balanceB).to.equal(DEPOSIT);

      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            200n,
            activeEpochSignature,
          ),
      ).to.be.revertedWithCustomError(pc, "InvalidSignature");

      const currentSignature = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        201n,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            201n,
            currentSignature,
          ),
      ).to.emit(pc, "ChannelUnilateralClose");
    });

    it("should revert refund before expiry", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "HTLCCreated",
      );
      const htlcId = event.args[0];

      await expect(
        pc.connect(partyA).refundHTLC(htlcId),
      ).to.be.revertedWithCustomError(pc, "HTLCNotExpired");
    });

    it("should revert claim after expiry", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);

      const tx = await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "HTLCCreated",
      );
      const htlcId = event.args[0];

      await time.increaseTo(timelock + 1n);

      await expect(
        pc.connect(partyB).claimHTLC(htlcId, preimage),
      ).to.be.revertedWithCustomError(pc, "HTLCExpired");
    });

    it("should revert HTLC with zero amount", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [ethers.randomBytes(32)]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      await expect(
        pc.connect(partyA).createHTLC(channelId, 0, hashLock, timelock),
      ).to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert HTLC with insufficient balance", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [ethers.randomBytes(32)]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const tooMuch = ethers.parseUnits("20000", 6); // more than partyA's balance
      await expect(
        pc.connect(partyA).createHTLC(channelId, tooMuch, hashLock, timelock),
      ).to.be.revertedWithCustomError(pc, "InsufficientDeposit");
    });

    it("should revert HTLC with timelock too short", async function () {
      const { pc, partyA, channelId } = await channelActiveFixture();
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [ethers.randomBytes(32)]),
      );
      const timelock = BigInt(await time.latest()) + 100n; // less than MIN_HTLC_TIMELOCK (1 hour)
      await expect(
        pc.connect(partyA).createHTLC(channelId, 1000, hashLock, timelock),
      ).to.be.revertedWithCustomError(pc, "InvalidTimelock");
    });

    it("tracks active locked value and blocks cooperative and unilateral close", async function () {
      const { pc, partyA, partyB, channelId } = await channelActiveFixture();
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      const amount = ethers.parseUnits("1000", 6);
      await pc
        .connect(partyA)
        .createHTLC(channelId, amount, hashLock, timelock);
      expect(await pc.activeHTLCLockedAmount(channelId)).to.equal(amount);

      const closeSigA = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyA,
      );
      const closeSigB = await signCloseState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .cooperativeClose(
            channelId,
            DEPOSIT,
            DEPOSIT,
            1,
            closeSigA,
            closeSigB,
          ),
      )
        .to.be.revertedWithCustomError(pc, "ActiveHTLCLock")
        .withArgs(channelId, amount);

      const stateSigB = await signState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        partyB,
      );
      await expect(
        pc
          .connect(partyA)
          .initiateUnilateralClose(channelId, DEPOSIT, DEPOSIT, 1, stateSigB),
      )
        .to.be.revertedWithCustomError(pc, "ActiveHTLCLock")
        .withArgs(channelId, amount);
    });

    it("blocks final settlement of a migrated closing channel with an unresolved HTLC", async function () {
      const [admin, partyA, partyB, treasury] = await ethers.getSigners();
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token = await MockERC20.deploy("USDC", "USDC", 6);
      const Harness = await ethers.getContractFactory(
        "PaymentChannelsTestHarness",
      );
      const pc = await Harness.deploy(admin.address, treasury.address, 0);
      const Registry = await ethers.getContractFactory("MockBusinessRegistry");
      const registry = await Registry.deploy();
      await pc.connect(admin).configureBusinessRegistry(registry.target);
      await pc.connect(admin).setSupportedToken(token.target, true);
      await registry.setBusiness(partyA.address, true, 0);
      await registry.setBusiness(partyB.address, true, 0);
      await token.mint(partyA.address, DEPOSIT);
      await token.mint(partyB.address, DEPOSIT);
      await token.connect(partyA).approve(pc.target, DEPOSIT);
      await token.connect(partyB).approve(pc.target, DEPOSIT);
      const openTx = await pc
        .connect(partyA)
        .openChannel(partyB.address, token.target, DEPOSIT, CHALLENGE_PERIOD);
      const receipt = await openTx.wait();
      const channelId = receipt.logs.find(
        (log) => log.fragment?.name === "ChannelOpened",
      ).args.channelId;
      await pc.connect(partyB).fundChannel(channelId, DEPOSIT);
      const preimage = ethers.hexlify(ethers.randomBytes(32));
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const amount = ethers.parseUnits("1000", 6);
      await pc
        .connect(partyA)
        .createHTLC(
          channelId,
          amount,
          hashLock,
          BigInt(await time.latest()) + 7200n,
        );
      await pc.forceClosingStateForTest(channelId, DEPOSIT, DEPOSIT, 1, 0);

      await expect(pc.finalizeClose(channelId))
        .to.be.revertedWithCustomError(pc, "ActiveHTLCLock")
        .withArgs(channelId, amount);
    });
  });

  describe("Batch Operations", function () {
    it("should batch open channels", async function () {
      const { pc, usdc, partyA, partyB, partyC } =
        await loadFixture(deployFixture);
      const dep = ethers.parseUnits("5000", 6);
      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            [partyB.address, partyC.address],
            usdc.target,
            [dep, dep],
            CHALLENGE_PERIOD,
          ),
      ).to.emit(pc, "ChannelBatchOpened");
    });

    it("should revert empty batch", async function () {
      const { pc, usdc, partyA } = await loadFixture(deployFixture);
      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels([], usdc.target, [], CHALLENGE_PERIOD),
      ).to.be.revertedWithCustomError(pc, "ZeroAmount");
    });

    it("should revert batch too large", async function () {
      const { pc, usdc, partyA, partyB } = await loadFixture(deployFixture);
      const counterparties = Array(21).fill(partyB.address);
      const deposits = Array(21).fill(DEPOSIT);
      await expect(
        pc
          .connect(partyA)
          .batchOpenChannels(
            counterparties,
            usdc.target,
            deposits,
            CHALLENGE_PERIOD,
          ),
      ).to.be.revertedWithCustomError(pc, "BatchTooLarge");
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
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      const timelock = BigInt(await time.latest()) + 7200n;
      await pc
        .connect(partyA)
        .createHTLC(
          channelId,
          ethers.parseUnits("1000", 6),
          hashLock,
          timelock,
        );
      const htlcs = await pc.getChannelHTLCs(channelId);
      expect(htlcs.length).to.equal(1);
    });

    it("should compute state hash", async function () {
      const { pc, channelId } = await channelActiveFixture();
      const hash = await pc.computeStateHash(
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        "STATE",
      );
      const expected = await hashChannelState(
        pc,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1,
        "STATE",
      );
      expect(hash).to.equal(expected);
    });
  });

  describe("Admin", function () {
    it("should set supported token", async function () {
      const { pc, usdc, admin } = await loadFixture(deployFixture);
      await pc.connect(admin).setSupportedToken(usdc.target, false);
      await expect(
        pc.connect(admin).setSupportedToken(usdc.target, true),
      ).to.emit(pc, "TokenSupported");
    });

    it("rejects EOAs and incomplete contracts from the settlement-token allowlist", async function () {
      const { pc, admin, other } = await loadFixture(deployFixture);
      await expect(pc.connect(admin).setSupportedToken(other.address, true))
        .to.be.revertedWithCustomError(pc, "InvalidSettlementToken")
        .withArgs(other.address);
      await expect(pc.connect(admin).setSupportedToken(pc.target, true))
        .to.be.revertedWithCustomError(pc, "InvalidSettlementToken")
        .withArgs(pc.target);

      const MetadataOnly = await ethers.getContractFactory(
        "MockMetadataOnlyToken",
      );
      const metadataOnly = await MetadataOnly.deploy();
      await expect(
        pc.connect(admin).setSupportedToken(metadataOnly.target, true),
      )
        .to.be.revertedWithCustomError(pc, "InvalidSettlementToken")
        .withArgs(metadataOnly.target);

      const MissingBalance = await ethers.getContractFactory(
        "MockMissingBalanceToken",
      );
      const missingBalance = await MissingBalance.deploy();
      await expect(
        pc.connect(admin).setSupportedToken(missingBalance.target, true),
      )
        .to.be.revertedWithCustomError(pc, "InvalidSettlementToken")
        .withArgs(missingBalance.target);
    });

    it("rejects ERC20 settlement tokens that do not use exactly six decimals", async function () {
      const { pc, admin } = await loadFixture(deployFixture);
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const token18 = await MockERC20.deploy("Token", "TOK", 18);
      await expect(pc.connect(admin).setSupportedToken(token18.target, true))
        .to.be.revertedWithCustomError(pc, "InvalidTokenDecimals")
        .withArgs(18);
    });

    it("reports the registry's current KYC decision instead of a snapshot", async function () {
      const { pc, registry, partyA } = await loadFixture(deployFixture);
      expect(await pc.kycVerified(partyA.address)).to.be.true;
      await registry.setBusiness(partyA.address, false, 0);
      expect(await pc.kycVerified(partyA.address)).to.be.false;
    });

    it("configures the BusinessRegistry only once and rejects invalid targets", async function () {
      const { admin, other, treasury } = await loadFixture(deployFixture);
      const PC = await ethers.getContractFactory("PaymentChannels");
      const fresh = await PC.deploy(admin.address, treasury.address, 100);

      await expect(
        fresh.connect(admin).configureBusinessRegistry(ethers.ZeroAddress),
      )
        .to.be.revertedWithCustomError(fresh, "InvalidBusinessRegistry")
        .withArgs(ethers.ZeroAddress);
      await expect(
        fresh.connect(admin).configureBusinessRegistry(other.address),
      )
        .to.be.revertedWithCustomError(fresh, "InvalidBusinessRegistry")
        .withArgs(other.address);

      const MetadataOnly = await ethers.getContractFactory(
        "MockMetadataOnlyToken",
      );
      const incompatible = await MetadataOnly.deploy();
      await expect(
        fresh.connect(admin).configureBusinessRegistry(incompatible.target),
      )
        .to.be.revertedWithCustomError(fresh, "InvalidBusinessRegistry")
        .withArgs(incompatible.target);

      const Registry = await ethers.getContractFactory("MockBusinessRegistry");
      const registry = await Registry.deploy();
      await expect(
        fresh.connect(admin).configureBusinessRegistry(registry.target),
      )
        .to.emit(fresh, "BusinessRegistryConfigured")
        .withArgs(registry.target);
      await expect(
        fresh.connect(admin).configureBusinessRegistry(registry.target),
      ).to.be.revertedWithCustomError(
        fresh,
        "BusinessRegistryAlreadyConfigured",
      );
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
