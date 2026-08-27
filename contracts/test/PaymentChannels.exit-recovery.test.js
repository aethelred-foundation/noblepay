const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const { signChannelState } = require("./helpers/paymentChannels");

describe("PaymentChannels exit and treasury recovery", function () {
  const DEPOSIT = ethers.parseUnits("10000", 6);
  const CHALLENGE_PERIOD = 24 * 60 * 60;

  async function deployFixture() {
    const [
      admin,
      partyA,
      partyB,
      treasury,
      recoveryTreasury,
      treasuryManager,
      outsider,
    ] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockBlacklistERC20");
    const token = await Token.deploy();
    const Registry = await ethers.getContractFactory("MockBusinessRegistry");
    const registry = await Registry.deploy();
    const Channels = await ethers.getContractFactory("PaymentChannels");
    const channels = await Channels.deploy(
      admin.address,
      treasury.address,
      100,
    );

    await channels.connect(admin).configureBusinessRegistry(registry.target);
    await channels.connect(admin).setSupportedToken(token.target, true);
    await registry.setBusiness(partyA.address, true, 0);
    await registry.setBusiness(partyB.address, true, 0);

    const treasuryRole = await channels.TREASURY_ROLE();
    await channels
      .connect(admin)
      .grantRole(treasuryRole, treasuryManager.address);

    for (const party of [partyA, partyB]) {
      await token.mint(party.address, DEPOSIT * 10n);
      await token.connect(party).approve(channels.target, ethers.MaxUint256);
    }

    return {
      admin,
      partyA,
      partyB,
      treasury,
      recoveryTreasury,
      treasuryManager,
      outsider,
      token,
      registry,
      channels,
    };
  }

  async function openChannel(fixture) {
    const { channels, partyA, partyB, token } = fixture;
    const tx = await channels
      .connect(partyA)
      .openChannel(partyB.address, token.target, DEPOSIT, CHALLENGE_PERIOD);
    const receipt = await tx.wait();
    const channelId = receipt.logs.find(
      (log) => log.fragment?.name === "ChannelOpened",
    ).args.channelId;
    return { ...fixture, channelId };
  }

  async function activeChannelFixture() {
    const fixture = await openChannel(await loadFixture(deployFixture));
    await fixture.channels
      .connect(fixture.partyB)
      .fundChannel(fixture.channelId, DEPOSIT);
    return fixture;
  }

  async function closingCurrentStateFixture() {
    const fixture = await activeChannelFixture();
    await fixture.channels
      .connect(fixture.partyA)
      .initiateCurrentStateClose(fixture.channelId);
    return fixture;
  }

  describe("unfunded OPEN channel cancellation", function () {
    it("refunds opener top-ups exactly, without a fee, despite pause and KYC revocation", async function () {
      const fixture = await openChannel(await loadFixture(deployFixture));
      const { channels, token, registry, admin, partyA, treasury, channelId } =
        fixture;

      await channels.connect(partyA).fundChannel(channelId, DEPOSIT / 2n);
      const openerBefore = await token.balanceOf(partyA.address);
      const treasuryBefore = await token.balanceOf(treasury.address);
      const refundAmount = DEPOSIT + DEPOSIT / 2n;

      await registry.setBusiness(partyA.address, false, 0);
      await channels.connect(admin).pause();

      await expect(channels.connect(partyA).cancelOpenChannel(channelId))
        .to.emit(channels, "ChannelCancelled")
        .withArgs(channelId, partyA.address, refundAmount)
        .and.to.emit(channels, "ChannelClosed")
        .withArgs(channelId, refundAmount, 0);

      const channel = await channels.getChannel(channelId);
      expect(channel.status).to.equal(5n);
      expect(await token.balanceOf(partyA.address)).to.equal(
        openerBefore + refundAmount,
      );
      expect(await token.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await token.balanceOf(channels.target)).to.equal(0n);

      await expect(
        channels.connect(partyA).cancelOpenChannel(channelId),
      ).to.be.revertedWithCustomError(channels, "InvalidChannelStatus");
      expect(await token.balanceOf(partyA.address)).to.equal(
        openerBefore + refundAmount,
      );
    });

    it("is opener-only and cannot cancel after the counterparty funds", async function () {
      const fixture = await openChannel(await loadFixture(deployFixture));
      const { channels, partyA, partyB, outsider, channelId } = fixture;

      await expect(
        channels.connect(partyB).cancelOpenChannel(channelId),
      ).to.be.revertedWithCustomError(channels, "NotChannelOpener");
      await expect(
        channels.connect(outsider).cancelOpenChannel(channelId),
      ).to.be.revertedWithCustomError(channels, "NotChannelOpener");

      await channels.connect(partyB).fundChannel(channelId, DEPOSIT);
      await expect(
        channels.connect(partyA).cancelOpenChannel(channelId),
      ).to.be.revertedWithCustomError(channels, "InvalidChannelStatus");
    });
  });

  describe("signature-free ACTIVE channel exit", function () {
    it("starts the normal challenge while paused/KYC-revoked and accepts a higher jointly authorized state", async function () {
      const fixture = await activeChannelFixture();
      const { channels, registry, admin, partyA, partyB, channelId } = fixture;
      const higherBalanceA = DEPOSIT + DEPOSIT / 5n;
      const higherBalanceB = DEPOSIT - DEPOSIT / 5n;
      const higherNonce = 1n;
      const partyASignature = await signChannelState(
        channels,
        partyA,
        channelId,
        higherBalanceA,
        higherBalanceB,
        higherNonce,
        "STATE",
      );

      await registry.setBusiness(partyB.address, false, 0);
      await channels.connect(admin).pause();

      await expect(
        channels.connect(partyA).initiateCurrentStateClose(channelId),
      )
        .to.emit(channels, "ChannelCurrentStateClose")
        .withArgs(channelId, partyA.address, DEPOSIT, DEPOSIT, 0n)
        .and.to.emit(channels, "DisputeInitiated");

      const initialDispute = await channels.getDispute(channelId);
      expect(initialDispute.challengeBalanceA).to.equal(DEPOSIT);
      expect(initialDispute.challengeBalanceB).to.equal(DEPOSIT);
      expect(initialDispute.challengeNonce).to.equal(0n);

      await expect(
        channels
          .connect(partyB)
          .counterDispute(
            channelId,
            higherBalanceA,
            higherBalanceB,
            higherNonce,
            partyASignature,
          ),
      ).to.emit(channels, "DisputeCountered");

      const countered = await channels.getDispute(channelId);
      expect(countered.challengeBalanceA).to.equal(higherBalanceA);
      expect(countered.challengeBalanceB).to.equal(higherBalanceB);
      expect(countered.challengeNonce).to.equal(higherNonce);
    });

    it("rejects OPEN/non-party use and active HTLC exposure", async function () {
      const opened = await openChannel(await loadFixture(deployFixture));
      await expect(
        opened.channels
          .connect(opened.partyA)
          .initiateCurrentStateClose(opened.channelId),
      ).to.be.revertedWithCustomError(opened.channels, "InvalidChannelStatus");

      const fixture = await activeChannelFixture();
      await expect(
        fixture.channels
          .connect(fixture.outsider)
          .initiateCurrentStateClose(fixture.channelId),
      ).to.be.revertedWithCustomError(fixture.channels, "NotChannelParty");

      const preimage = ethers.id("current-close-active-htlc");
      const hashLock = ethers.keccak256(
        ethers.solidityPacked(["bytes32"], [preimage]),
      );
      await fixture.channels
        .connect(fixture.partyA)
        .createHTLC(
          fixture.channelId,
          DEPOSIT / 10n,
          hashLock,
          BigInt(await time.latest()) + 7200n,
        );
      await expect(
        fixture.channels
          .connect(fixture.partyA)
          .initiateCurrentStateClose(fixture.channelId),
      ).to.be.revertedWithCustomError(fixture.channels, "ActiveHTLCLock");
    });
  });

  describe("challenge deadline boundary", function () {
    it("allows a counter-dispute in the block exactly at expiresAt", async function () {
      const fixture = await closingCurrentStateFixture();
      const { channels, partyA, partyB, channelId } = fixture;
      const dispute = await channels.getDispute(channelId);
      const signature = await signChannelState(
        channels,
        partyA,
        channelId,
        DEPOSIT,
        DEPOSIT,
        1n,
        "STATE",
      );

      await time.setNextBlockTimestamp(dispute.expiresAt);
      await expect(
        channels
          .connect(partyB)
          .counterDispute(channelId, DEPOSIT, DEPOSIT, 1n, signature),
      ).to.emit(channels, "DisputeCountered");
    });

    it("permits finalization only strictly after expiresAt", async function () {
      const fixture = await closingCurrentStateFixture();
      const { channels, channelId } = fixture;
      const dispute = await channels.getDispute(channelId);

      await time.setNextBlockTimestamp(dispute.expiresAt);
      await expect(
        channels.finalizeClose(channelId),
      ).to.be.revertedWithCustomError(channels, "ChallengeNotExpired");

      await time.setNextBlockTimestamp(dispute.expiresAt + 1n);
      await expect(channels.finalizeClose(channelId)).to.emit(
        channels,
        "DisputeResolved",
      );
    });

    it("finalizes the canonical exit while an emergency pause remains indefinite", async function () {
      const fixture = await activeChannelFixture();
      const { channels, token, admin, partyA, partyB, outsider, channelId } =
        fixture;
      await channels
        .connect(partyA)
        .initiateCurrentStateClose(channelId);
      const dispute = await channels.getDispute(channelId);
      await channels.connect(admin).pause();
      await time.increaseTo(dispute.expiresAt + 1n);

      const partyABefore = await token.balanceOf(partyA.address);
      const partyBBefore = await token.balanceOf(partyB.address);
      await expect(channels.connect(outsider).finalizeClose(channelId))
        .to.emit(channels, "DisputeResolved")
        .and.to.emit(channels, "ChannelClosed");

      expect(await channels.paused()).to.equal(true);
      expect((await channels.getChannel(channelId)).status).to.equal(5n);
      const feePerParty = (DEPOSIT * 100n) / 10_000n;
      expect(await token.balanceOf(partyA.address)).to.equal(
        partyABefore + DEPOSIT - feePerParty,
      );
      expect(await token.balanceOf(partyB.address)).to.equal(
        partyBBefore + DEPOSIT - feePerParty,
      );
    });
  });

  describe("bounded fee and treasury recovery", function () {
    it("separates treasury authority and enforces the immutable 5% cap", async function () {
      const {
        channels,
        treasury,
        recoveryTreasury,
        treasuryManager,
        outsider,
      } = await loadFixture(deployFixture);

      await expect(
        channels
          .connect(outsider)
          .setProtocolTreasury(recoveryTreasury.address),
      ).to.be.reverted;
      await expect(channels.connect(outsider).setProtocolFeeBps(0)).to.be
        .reverted;
      await expect(
        channels
          .connect(treasuryManager)
          .setProtocolTreasury(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(channels, "ZeroAddress");
      await expect(
        channels.connect(treasuryManager).setProtocolFeeBps(501),
      ).to.be.revertedWithCustomError(channels, "InvalidFee");

      await expect(
        channels
          .connect(treasuryManager)
          .setProtocolTreasury(recoveryTreasury.address),
      )
        .to.emit(channels, "ProtocolTreasuryUpdated")
        .withArgs(treasury.address, recoveryTreasury.address);
      await expect(channels.connect(treasuryManager).setProtocolFeeBps(0))
        .to.emit(channels, "ProtocolFeeUpdated")
        .withArgs(100n, 0n);
    });

    it("atomically preserves a failed close and recovers by rotating a blacklisted treasury", async function () {
      const fixture = await closingCurrentStateFixture();
      const {
        channels,
        token,
        partyA,
        partyB,
        treasury,
        recoveryTreasury,
        treasuryManager,
        channelId,
      } = fixture;
      const dispute = await channels.getDispute(channelId);
      await time.increaseTo(dispute.expiresAt + 1n);
      await token.setBlacklisted(treasury.address, true);

      const balanceABefore = await token.balanceOf(partyA.address);
      const balanceBBefore = await token.balanceOf(partyB.address);
      await expect(channels.finalizeClose(channelId))
        .to.be.revertedWithCustomError(token, "BlacklistedAddress")
        .withArgs(treasury.address);
      expect((await channels.getChannel(channelId)).status).to.equal(3n);
      expect((await channels.getDispute(channelId)).resolved).to.be.false;
      expect(await token.balanceOf(partyA.address)).to.equal(balanceABefore);
      expect(await token.balanceOf(partyB.address)).to.equal(balanceBBefore);

      await channels
        .connect(treasuryManager)
        .setProtocolTreasury(recoveryTreasury.address);
      await expect(channels.finalizeClose(channelId)).to.emit(
        channels,
        "ChannelClosed",
      );

      const expectedFee = ((DEPOSIT * 100n) / 10_000n) * 2n;
      expect(await token.balanceOf(recoveryTreasury.address)).to.equal(
        expectedFee,
      );
      expect((await channels.getChannel(channelId)).status).to.equal(5n);
    });

    it("recovers without a treasury transfer by setting the bounded fee to zero", async function () {
      const fixture = await closingCurrentStateFixture();
      const {
        channels,
        token,
        partyA,
        partyB,
        treasury,
        treasuryManager,
        channelId,
      } = fixture;
      const dispute = await channels.getDispute(channelId);
      await time.increaseTo(dispute.expiresAt + 1n);
      await token.setBlacklisted(treasury.address, true);

      await channels.connect(treasuryManager).setProtocolFeeBps(0);
      const balanceABefore = await token.balanceOf(partyA.address);
      const balanceBBefore = await token.balanceOf(partyB.address);
      await channels.finalizeClose(channelId);

      expect(await token.balanceOf(partyA.address)).to.equal(
        balanceABefore + DEPOSIT,
      );
      expect(await token.balanceOf(partyB.address)).to.equal(
        balanceBBefore + DEPOSIT,
      );
      expect(await token.balanceOf(treasury.address)).to.equal(0n);
    });
  });
});
