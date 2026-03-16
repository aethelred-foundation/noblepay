const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("CrossChainRouter", function () {
  const CHAIN_ID = 137; // Polygon
  const BASE_FEE = ethers.parseUnits("10", 6);
  const FEE_RATE_BP = 50; // 0.5%
  const FINALITY_BLOCKS = 128;
  const RECOVERY_TIMEOUT = 4 * 3600; // 4 hours
  const MIN_TRANSFER = ethers.parseUnits("100", 6);
  const MAX_TRANSFER = ethers.parseUnits("1000000", 6);

  async function deployFixture() {
    const [admin, relay1, relay2, sender, treasuryAddr, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USDC", "USDC", 6);

    const Router = await ethers.getContractFactory("CrossChainRouter");
    const router = await Router.deploy(admin.address, treasuryAddr.address);

    // Setup token
    await router.connect(admin).setTokenSupport(usdc.target, true);

    // Add chain
    await router.connect(admin).addChain(
      CHAIN_ID, "Polygon", BASE_FEE, FEE_RATE_BP, FINALITY_BLOCKS,
      RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER
    );

    // Mint tokens to sender
    const mintAmount = ethers.parseUnits("10000000", 6);
    await usdc.mint(sender.address, mintAmount);
    await usdc.connect(sender).approve(router.target, ethers.MaxUint256);

    return { router, usdc, admin, relay1, relay2, sender, treasuryAddr, other };
  }

  async function relayRegisteredFixture() {
    const fixture = await loadFixture(deployFixture);
    const { router, relay1 } = fixture;
    await router.connect(relay1).registerRelay({ value: ethers.parseEther("5") });
    return fixture;
  }

  async function transferInitiatedFixture() {
    const fixture = await relayRegisteredFixture();
    const { router, usdc, sender } = fixture;
    const amount = ethers.parseUnits("1000", 6);
    const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient_on_polygon"));
    const tx = await router.connect(sender).initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash);
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment && l.fragment.name === "TransferInitiated");
    const transferId = event.args[0];
    return { ...fixture, transferId, amount, recipientHash };
  }

  describe("Deployment", function () {
    it("should set admin and treasury", async function () {
      const { router, admin, treasuryAddr } = await loadFixture(deployFixture);
      const ADMIN_ROLE = await router.ROUTER_ADMIN_ROLE();
      expect(await router.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await router.treasury()).to.equal(treasuryAddr.address);
    });

    it("should revert with zero admin", async function () {
      const Router = await ethers.getContractFactory("CrossChainRouter");
      const [, t] = await ethers.getSigners();
      await expect(Router.deploy(ethers.ZeroAddress, t.address))
        .to.be.revertedWithCustomError(Router, "ZeroAddress");
    });

    it("should revert with zero treasury", async function () {
      const Router = await ethers.getContractFactory("CrossChainRouter");
      const [a] = await ethers.getSigners();
      await expect(Router.deploy(a.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Router, "ZeroAddress");
    });
  });

  describe("Chain Management", function () {
    it("should add a chain", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).addChain(
        42161, "Arbitrum", BASE_FEE, FEE_RATE_BP, 1, RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER
      )).to.emit(router, "ChainAdded");
    });

    it("should revert duplicate chain", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).addChain(
        CHAIN_ID, "Polygon2", BASE_FEE, FEE_RATE_BP, 1, RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER
      )).to.be.revertedWithCustomError(router, "ChainAlreadyExists");
    });

    it("should revert excessive fee rate", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).addChain(
        42161, "Arbitrum", BASE_FEE, 201, 1, RECOVERY_TIMEOUT, MIN_TRANSFER, MAX_TRANSFER
      )).to.be.revertedWithCustomError(router, "InvalidFeeRate");
    });

    it("should revert recovery timeout too short", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).addChain(
        42161, "Arbitrum", BASE_FEE, FEE_RATE_BP, 1, 3600, MIN_TRANSFER, MAX_TRANSFER // 1h < 2h min
      )).to.be.revertedWithCustomError(router, "InvalidRecoveryTimeout");
    });

    it("should remove a chain", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).removeChain(CHAIN_ID))
        .to.emit(router, "ChainRemoved");
    });

    it("should revert remove non-existent chain", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).removeChain(999))
        .to.be.revertedWithCustomError(router, "UnsupportedChain");
    });
  });

  describe("Relay Registration", function () {
    it("should register a relay", async function () {
      const { router, relay1 } = await loadFixture(deployFixture);
      await expect(router.connect(relay1).registerRelay({ value: ethers.parseEther("5") }))
        .to.emit(router, "RelayRegistered");
      const node = await router.getRelayNode(relay1.address);
      expect(node.reputation).to.equal(500);
      expect(node.active).to.be.true;
    });

    it("should revert insufficient stake", async function () {
      const { router, relay1 } = await loadFixture(deployFixture);
      await expect(router.connect(relay1).registerRelay({ value: ethers.parseEther("1") }))
        .to.be.revertedWithCustomError(router, "InsufficientStake");
    });

    it("should revert duplicate registration", async function () {
      const { router, relay1 } = await relayRegisteredFixture();
      await expect(router.connect(relay1).registerRelay({ value: ethers.parseEther("5") }))
        .to.be.revertedWithCustomError(router, "RelayAlreadyRegistered");
    });

    it("should deregister a relay", async function () {
      const { router, relay1 } = await relayRegisteredFixture();
      await expect(router.connect(relay1).deregisterRelay(relay1.address))
        .to.emit(router, "RelayDeregistered");
      const node = await router.getRelayNode(relay1.address);
      expect(node.active).to.be.false;
    });

    it("should deregister relay by admin", async function () {
      const { router, admin, relay1 } = await relayRegisteredFixture();
      await expect(router.connect(admin).deregisterRelay(relay1.address))
        .to.emit(router, "RelayDeregistered");
    });

    it("should revert deregister non-existent relay", async function () {
      const { router, other } = await loadFixture(deployFixture);
      await expect(router.connect(other).deregisterRelay(other.address))
        .to.be.revertedWithCustomError(router, "RelayNotFound");
    });
  });

  describe("Transfer Initiation", function () {
    it("should initiate a transfer", async function () {
      const { router, usdc, sender } = await relayRegisteredFixture();
      const amount = ethers.parseUnits("1000", 6);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
      await expect(router.connect(sender).initiateTransfer(usdc.target, amount, CHAIN_ID, recipientHash))
        .to.emit(router, "TransferInitiated");
    });

    it("should revert for unsupported token", async function () {
      const { router, sender, other } = await loadFixture(deployFixture);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
      await expect(router.connect(sender).initiateTransfer(other.address, 1000, CHAIN_ID, recipientHash))
        .to.be.revertedWithCustomError(router, "UnsupportedToken");
    });

    it("should revert for unsupported chain", async function () {
      const { router, usdc, sender } = await loadFixture(deployFixture);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
      await expect(router.connect(sender).initiateTransfer(usdc.target, ethers.parseUnits("1000", 6), 999, recipientHash))
        .to.be.revertedWithCustomError(router, "UnsupportedChain");
    });

    it("should revert for amount below minimum", async function () {
      const { router, usdc, sender } = await loadFixture(deployFixture);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
      await expect(router.connect(sender).initiateTransfer(usdc.target, ethers.parseUnits("10", 6), CHAIN_ID, recipientHash))
        .to.be.revertedWithCustomError(router, "AmountBelowMinimum");
    });

    it("should revert for amount above maximum", async function () {
      const { router, usdc, sender } = await loadFixture(deployFixture);
      await usdc.mint(sender.address, ethers.parseUnits("2000000", 6));
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
      await expect(router.connect(sender).initiateTransfer(usdc.target, ethers.parseUnits("1500000", 6), CHAIN_ID, recipientHash))
        .to.be.revertedWithCustomError(router, "AmountAboveMaximum");
    });

    it("should revert for zero amount", async function () {
      const { router, usdc, sender } = await loadFixture(deployFixture);
      const recipientHash = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
      await expect(router.connect(sender).initiateTransfer(usdc.target, 0, CHAIN_ID, recipientHash))
        .to.be.revertedWithCustomError(router, "ZeroAmount");
    });
  });

  describe("Relay Operations", function () {
    it("should submit relay proof", async function () {
      const { router, relay1, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      const proof = ethers.toUtf8Bytes("valid_proof_data");
      await expect(router.connect(relay1).submitRelayProof(transferId, destTxHash, proof))
        .to.emit(router, "TransferRelayed");
    });

    it("should revert relay by non-active relay", async function () {
      const { router, other, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      const proof = ethers.toUtf8Bytes("proof");
      await expect(router.connect(other).submitRelayProof(transferId, destTxHash, proof))
        .to.be.revertedWithCustomError(router, "RelayNotActive");
    });

    it("should revert relay with empty proof", async function () {
      const { router, relay1, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      await expect(router.connect(relay1).submitRelayProof(transferId, destTxHash, "0x"))
        .to.be.revertedWithCustomError(router, "InvalidProof");
    });

    it("should confirm a relayed transfer", async function () {
      const { router, admin, relay1, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      await router.connect(relay1).submitRelayProof(transferId, destTxHash, ethers.toUtf8Bytes("proof"));
      await expect(router.connect(admin).confirmTransfer(transferId))
        .to.emit(router, "TransferCompleted");
    });

    it("should update reputation on success", async function () {
      const { router, admin, relay1, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      await router.connect(relay1).submitRelayProof(transferId, destTxHash, ethers.toUtf8Bytes("proof"));
      await router.connect(admin).confirmTransfer(transferId);
      const node = await router.getRelayNode(relay1.address);
      expect(node.reputation).to.equal(501); // 500 + 1
      expect(node.totalRelayed).to.equal(1);
    });

    it("should mark transfer as failed", async function () {
      const { router, admin, relay1, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      await router.connect(relay1).submitRelayProof(transferId, destTxHash, ethers.toUtf8Bytes("proof"));
      await expect(router.connect(admin).markTransferFailed(transferId, "delivery failed"))
        .to.emit(router, "TransferFailed");
    });

    it("should penalize relay on failure", async function () {
      const { router, admin, relay1, transferId } = await transferInitiatedFixture();
      const destTxHash = ethers.keccak256(ethers.toUtf8Bytes("dest_tx_1"));
      await router.connect(relay1).submitRelayProof(transferId, destTxHash, ethers.toUtf8Bytes("proof"));
      await router.connect(admin).markTransferFailed(transferId, "failed");
      const node = await router.getRelayNode(relay1.address);
      expect(node.reputation).to.equal(450); // 500 - 50
      expect(node.totalFailed).to.equal(1);
    });
  });

  describe("Recovery", function () {
    it("should recover transfer after deadline", async function () {
      const { router, sender, transferId } = await transferInitiatedFixture();
      await time.increase(RECOVERY_TIMEOUT + 1);
      await expect(router.connect(sender).recoverTransfer(transferId))
        .to.emit(router, "TransferRecovered");
    });

    it("should revert recovery before deadline", async function () {
      const { router, sender, transferId } = await transferInitiatedFixture();
      await expect(router.connect(sender).recoverTransfer(transferId))
        .to.be.revertedWithCustomError(router, "DeadlineNotExpired");
    });

    it("should recover a failed transfer without waiting", async function () {
      const { router, admin, sender, transferId } = await transferInitiatedFixture();
      await router.connect(admin).markTransferFailed(transferId, "failed");
      await expect(router.connect(sender).recoverTransfer(transferId))
        .to.emit(router, "TransferRecovered");
    });

    it("should revert recovery by unauthorized", async function () {
      const { router, other, transferId } = await transferInitiatedFixture();
      await time.increase(RECOVERY_TIMEOUT + 1);
      await expect(router.connect(other).recoverTransfer(transferId))
        .to.be.revertedWithCustomError(router, "Unauthorized");
    });

    it("should allow admin to recover", async function () {
      const { router, admin, transferId } = await transferInitiatedFixture();
      await time.increase(RECOVERY_TIMEOUT + 1);
      await expect(router.connect(admin).recoverTransfer(transferId))
        .to.emit(router, "TransferRecovered");
    });
  });

  describe("View Functions", function () {
    it("should return active relay count", async function () {
      const { router } = await relayRegisteredFixture();
      expect(await router.getActiveRelayCount()).to.equal(1);
    });

    it("should return supported chain count", async function () {
      const { router } = await loadFixture(deployFixture);
      expect(await router.getSupportedChainCount()).to.equal(1);
    });

    it("should return sender transfer count", async function () {
      const { router, sender } = await transferInitiatedFixture();
      expect(await router.getSenderTransferCount(sender.address)).to.equal(1);
    });

    it("should estimate fee", async function () {
      const { router } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);
      const estimate = await router.estimateFee(amount, CHAIN_ID);
      expect(estimate.baseFee).to.equal(BASE_FEE);
      expect(estimate.totalFee).to.equal(BASE_FEE + (amount * BigInt(FEE_RATE_BP) / 10000n));
    });

    it("should revert fee estimate for unsupported chain", async function () {
      const { router } = await loadFixture(deployFixture);
      await expect(router.estimateFee(1000, 999))
        .to.be.revertedWithCustomError(router, "UnsupportedChain");
    });
  });

  describe("Admin", function () {
    it("should set token support", async function () {
      const { router, admin, other } = await loadFixture(deployFixture);
      await expect(router.connect(admin).setTokenSupport(other.address, true))
        .to.emit(router, "TokenSupportUpdated");
    });

    it("should update treasury", async function () {
      const { router, admin, other } = await loadFixture(deployFixture);
      await expect(router.connect(admin).setTreasury(other.address))
        .to.emit(router, "TreasuryUpdated");
    });

    it("should revert set treasury to zero", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await expect(router.connect(admin).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("should pause and unpause", async function () {
      const { router, admin } = await loadFixture(deployFixture);
      await router.connect(admin).pause();
      expect(await router.paused()).to.be.true;
      await router.connect(admin).unpause();
      expect(await router.paused()).to.be.false;
    });
  });
});
