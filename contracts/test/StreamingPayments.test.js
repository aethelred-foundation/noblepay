import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("StreamingPayments", function () {
  async function deployFixture() {
    const [admin, sender, recipient, recipient2, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USDC", "USDC", 6);

    const Streaming = await ethers.getContractFactory("StreamingPayments");
    const streaming = await Streaming.deploy(admin.address);

    const amount = ethers.parseUnits("1000000", 6);
    await token.mint(sender.address, amount);
    await token.connect(sender).approve(streaming.target, ethers.MaxUint256);

    return { streaming, token, admin, sender, recipient, recipient2, other };
  }

  const DURATION = 3600; // 1 hour
  const CLIFF = 600; // 10 minutes
  const TOTAL = ethers.parseUnits("3600", 6); // 1 USDC/second

  async function streamCreatedFixture() {
    const fixture = await loadFixture(deployFixture);
    const { streaming, token, sender, recipient } = fixture;
    const tx = await streaming.connect(sender).createStream(
      recipient.address, token.target, TOTAL, DURATION, CLIFF
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "StreamCreated");
    const streamId = event.args[0];
    return { ...fixture, streamId };
  }

  describe("Deployment", function () {
    it("should set admin role", async function () {
      const { streaming, admin } = await loadFixture(deployFixture);
      const STREAM_ADMIN_ROLE = await streaming.STREAM_ADMIN_ROLE();
      expect(await streaming.hasRole(STREAM_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("should revert with zero admin", async function () {
      const S = await ethers.getContractFactory("StreamingPayments");
      await expect(S.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(S, "ZeroAddress");
    });
  });

  describe("Stream Creation", function () {
    it("should create a stream", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createStream(
        recipient.address, token.target, TOTAL, DURATION, CLIFF
      )).to.emit(streaming, "StreamCreated");
      expect(await streaming.getSenderStreamCount(sender.address)).to.equal(1);
      expect(await streaming.getRecipientStreamCount(recipient.address)).to.equal(1);
    });

    it("should revert for zero recipient", async function () {
      const { streaming, token, sender } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createStream(
        ethers.ZeroAddress, token.target, TOTAL, DURATION, CLIFF
      )).to.be.revertedWithCustomError(streaming, "ZeroAddress");
    });

    it("should revert for self-stream", async function () {
      const { streaming, token, sender } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createStream(
        sender.address, token.target, TOTAL, DURATION, CLIFF
      )).to.be.revertedWithCustomError(streaming, "InvalidRecipient");
    });

    it("should revert for zero amount", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createStream(
        recipient.address, token.target, 0, DURATION, CLIFF
      )).to.be.revertedWithCustomError(streaming, "ZeroAmount");
    });

    it("should revert for duration too short", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createStream(
        recipient.address, token.target, TOTAL, 60, 0 // 60 seconds < 1 hour
      )).to.be.revertedWithCustomError(streaming, "InvalidDuration");
    });

    it("should revert for cliff exceeding MAX_CLIFF_PERIOD", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      const longDuration = 366 * 24 * 3600;
      const longCliff = 366 * 24 * 3600;
      await expect(streaming.connect(sender).createStream(
        recipient.address, token.target, TOTAL, longDuration, longCliff
      )).to.be.revertedWithCustomError(streaming, "CliffTooLong");
    });

    it("should revert for cliff >= duration", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createStream(
        recipient.address, token.target, TOTAL, DURATION, DURATION
      )).to.be.revertedWithCustomError(streaming, "CliffExceedsDuration");
    });
  });

  describe("Withdrawals", function () {
    it("should revert withdrawal before cliff", async function () {
      const { streaming, recipient, streamId } = await streamCreatedFixture();
      await time.increase(300); // 5 minutes < 10 min cliff
      await expect(streaming.connect(recipient).withdraw(streamId))
        .to.be.revertedWithCustomError(streaming, "CliffNotReached");
    });

    it("should withdraw after cliff", async function () {
      const { streaming, token, recipient, streamId } = await streamCreatedFixture();
      await time.increase(CLIFF + 100); // past cliff
      await expect(streaming.connect(recipient).withdraw(streamId))
        .to.emit(streaming, "Withdrawal");
      const s = await streaming.getStream(streamId);
      expect(s.withdrawnAmount).to.be.gt(0);
    });

    it("should complete stream after full duration", async function () {
      const { streaming, recipient, streamId } = await streamCreatedFixture();
      await time.increase(DURATION + 1);
      await expect(streaming.connect(recipient).withdraw(streamId))
        .to.emit(streaming, "StreamCompleted");
    });

    it("should revert for non-recipient", async function () {
      const { streaming, other, streamId } = await streamCreatedFixture();
      await time.increase(CLIFF + 100);
      await expect(streaming.connect(other).withdraw(streamId))
        .to.be.revertedWithCustomError(streaming, "Unauthorized");
    });
  });

  describe("Pause & Resume", function () {
    it("should pause a stream", async function () {
      const { streaming, sender, streamId } = await streamCreatedFixture();
      await expect(streaming.connect(sender).pauseStream(streamId))
        .to.emit(streaming, "StreamPaused");
    });

    it("should resume a paused stream", async function () {
      const { streaming, sender, streamId } = await streamCreatedFixture();
      await streaming.connect(sender).pauseStream(streamId);
      await time.increase(100);
      await expect(streaming.connect(sender).resumeStream(streamId))
        .to.emit(streaming, "StreamResumed");
    });

    it("should revert pausing already paused", async function () {
      const { streaming, sender, streamId } = await streamCreatedFixture();
      await streaming.connect(sender).pauseStream(streamId);
      await expect(streaming.connect(sender).pauseStream(streamId))
        .to.be.revertedWithCustomError(streaming, "StreamNotActive");
    });

    it("should revert resuming active stream", async function () {
      const { streaming, sender, streamId } = await streamCreatedFixture();
      await expect(streaming.connect(sender).resumeStream(streamId))
        .to.be.revertedWithCustomError(streaming, "StreamNotPaused");
    });

    it("should revert pause by unauthorized", async function () {
      const { streaming, other, streamId } = await streamCreatedFixture();
      await expect(streaming.connect(other).pauseStream(streamId))
        .to.be.revertedWithCustomError(streaming, "Unauthorized");
    });

    it("admin should be able to pause", async function () {
      const { streaming, admin, streamId } = await streamCreatedFixture();
      await streaming.connect(admin).pauseStream(streamId);
      const s = await streaming.getStream(streamId);
      expect(s.status).to.equal(1); // PAUSED
    });
  });

  describe("Cancel", function () {
    it("should cancel and distribute pro-rata", async function () {
      const { streaming, token, sender, recipient, streamId } = await streamCreatedFixture();
      await time.increase(CLIFF + 600); // past cliff + 600s
      const recipBalBefore = await token.balanceOf(recipient.address);
      const senderBalBefore = await token.balanceOf(sender.address);
      await streaming.connect(sender).cancelStream(streamId);
      const recipBalAfter = await token.balanceOf(recipient.address);
      const senderBalAfter = await token.balanceOf(sender.address);
      // Recipient got accrued, sender got refund
      expect(recipBalAfter).to.be.gt(recipBalBefore);
      expect(senderBalAfter).to.be.gt(senderBalBefore);
    });

    it("should revert cancel of already cancelled stream", async function () {
      const { streaming, sender, streamId } = await streamCreatedFixture();
      await streaming.connect(sender).cancelStream(streamId);
      await expect(streaming.connect(sender).cancelStream(streamId))
        .to.be.revertedWithCustomError(streaming, "StreamNotActive");
    });

    it("should revert cancel by unauthorized", async function () {
      const { streaming, other, streamId } = await streamCreatedFixture();
      await expect(streaming.connect(other).cancelStream(streamId))
        .to.be.revertedWithCustomError(streaming, "Unauthorized");
    });
  });

  describe("Batch Streams", function () {
    it("should create batch streams", async function () {
      const { streaming, token, sender, recipient, recipient2 } = await loadFixture(deployFixture);
      const amt = ethers.parseUnits("3600", 6);
      await expect(streaming.connect(sender).createBatchStreams(
        [recipient.address, recipient2.address], token.target, [amt, amt], DURATION, CLIFF
      )).to.emit(streaming, "BatchStreamsCreated");
      expect(await streaming.getSenderStreamCount(sender.address)).to.equal(2);
    });

    it("should revert empty batch", async function () {
      const { streaming, token, sender } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createBatchStreams(
        [], token.target, [], DURATION, CLIFF
      )).to.be.revertedWithCustomError(streaming, "ZeroAmount");
    });

    it("should revert batch too large", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      const recipients = Array(51).fill(recipient.address);
      const amounts = Array(51).fill(TOTAL);
      await expect(streaming.connect(sender).createBatchStreams(
        recipients, token.target, amounts, DURATION, CLIFF
      )).to.be.revertedWithCustomError(streaming, "BatchTooLarge");
    });

    it("should revert array length mismatch", async function () {
      const { streaming, token, sender, recipient } = await loadFixture(deployFixture);
      await expect(streaming.connect(sender).createBatchStreams(
        [recipient.address], token.target, [TOTAL, TOTAL], DURATION, CLIFF
      )).to.be.revertedWithCustomError(streaming, "ArrayLengthMismatch");
    });
  });

  describe("View Functions", function () {
    it("should return withdrawable balance", async function () {
      const { streaming, streamId } = await streamCreatedFixture();
      await time.increase(CLIFF + 100);
      const bal = await streaming.withdrawableBalance(streamId);
      expect(bal).to.be.gt(0);
    });

    it("should return remaining balance", async function () {
      const { streaming, streamId } = await streamCreatedFixture();
      expect(await streaming.remainingBalance(streamId)).to.equal(TOTAL);
    });

    it("should return effective elapsed", async function () {
      const { streaming, streamId } = await streamCreatedFixture();
      await time.increase(500);
      const elapsed = await streaming.getEffectiveElapsed(streamId);
      expect(elapsed).to.be.gte(500);
    });
  });

  describe("Admin", function () {
    it("should pause and unpause", async function () {
      const { streaming, admin } = await loadFixture(deployFixture);
      await streaming.connect(admin).pause();
      expect(await streaming.paused()).to.be.true;
      await streaming.connect(admin).unpause();
      expect(await streaming.paused()).to.be.false;
    });
  });
});
