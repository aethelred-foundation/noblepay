const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("NoblePay", function () {
  async function deployFixture() {
    const [admin, treasury, teeNode, complianceOfficer, business1, business2, recipient, other] = await ethers.getSigners();

    const NoblePay = await ethers.getContractFactory("NoblePay");
    const baseFee = ethers.parseUnits("1", 6); // 1 USDC
    const percentageFee = 50; // 0.5%
    const noblepay = await NoblePay.deploy(admin.address, treasury.address, baseFee, percentageFee);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Setup roles
    const TEE_NODE_ROLE = await noblepay.TEE_NODE_ROLE();
    const COMPLIANCE_OFFICER_ROLE = await noblepay.COMPLIANCE_OFFICER_ROLE();
    const ADMIN_ROLE = await noblepay.ADMIN_ROLE();

    await noblepay.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await noblepay.connect(admin).grantRole(COMPLIANCE_OFFICER_ROLE, complianceOfficer.address);

    // Setup token
    await noblepay.connect(admin).setSupportedToken(usdc.target, true);

    // Register businesses
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true); // STANDARD
    await noblepay.connect(admin).syncBusiness(business2.address, 0, true);

    // Mint and approve tokens
    const amount = ethers.parseUnits("1000000", 6);
    await usdc.mint(business1.address, amount);
    await usdc.mint(business2.address, amount);
    await usdc.connect(business1).approve(noblepay.target, amount);
    await usdc.connect(business2).approve(noblepay.target, amount);

    return { noblepay, usdc, admin, treasury, teeNode, complianceOfficer, business1, business2, recipient, other, ADMIN_ROLE, TEE_NODE_ROLE, COMPLIANCE_OFFICER_ROLE };
  }

  describe("Deployment", function () {
    it("should set roles and fees correctly", async function () {
      const { noblepay, admin, treasury, ADMIN_ROLE } = await loadFixture(deployFixture);
      expect(await noblepay.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
      expect(await noblepay.treasury()).to.equal(treasury.address);
      expect(await noblepay.baseFee()).to.equal(ethers.parseUnits("1", 6));
      expect(await noblepay.percentageFee()).to.equal(50);
    });

    it("should revert with zero admin address", async function () {
      const NoblePay = await ethers.getContractFactory("NoblePay");
      await expect(NoblePay.deploy(ethers.ZeroAddress, ethers.ZeroAddress, 0, 0))
        .to.be.revertedWithCustomError(NoblePay, "ZeroAddress");
    });

    it("should revert with zero treasury address", async function () {
      const [admin] = await ethers.getSigners();
      const NoblePay = await ethers.getContractFactory("NoblePay");
      await expect(NoblePay.deploy(admin.address, ethers.ZeroAddress, 0, 0))
        .to.be.revertedWithCustomError(NoblePay, "ZeroAddress");
    });

    it("should revert with fee exceeding max", async function () {
      const [admin, treasury] = await ethers.getSigners();
      const NoblePay = await ethers.getContractFactory("NoblePay");
      await expect(NoblePay.deploy(admin.address, treasury.address, 0, 501))
        .to.be.revertedWithCustomError(NoblePay, "InvalidFee");
    });
  });

  describe("Payment Initiation", function () {
    it("should initiate an ERC20 payment", async function () {
      const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const purposeHash = ethers.keccak256(ethers.toUtf8Bytes("payment"));
      const currencyCode = ethers.encodeBytes32String("USD").slice(0, 8); // bytes3

      await expect(noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, purposeHash, currencyCode
      )).to.emit(noblepay, "PaymentInitiated");
    });

    it("should initiate a native payment", async function () {
      const { noblepay, business1, recipient } = await loadFixture(deployFixture);
      const amount = 1000n; // small amount within daily limit
      const purposeHash = ethers.keccak256(ethers.toUtf8Bytes("payment"));
      const currencyCode = "0x414554"; // "AET"

      await expect(noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, purposeHash, currencyCode,
        { value: amount }
      )).to.emit(noblepay, "PaymentInitiated");
    });

    it("should revert for unregistered business", async function () {
      const { noblepay, usdc, other, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      await expect(noblepay.connect(other).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      )).to.be.revertedWithCustomError(noblepay, "NotRegisteredBusiness");
    });

    it("should revert for zero amount", async function () {
      const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
      await expect(noblepay.connect(business1).initiatePayment(
        recipient.address, 0, usdc.target, ethers.ZeroHash, "0x555344"
      )).to.be.revertedWithCustomError(noblepay, "ZeroAmount");
    });

    it("should revert for zero recipient", async function () {
      const { noblepay, usdc, business1 } = await loadFixture(deployFixture);
      await expect(noblepay.connect(business1).initiatePayment(
        ethers.ZeroAddress, 100, usdc.target, ethers.ZeroHash, "0x555344"
      )).to.be.revertedWithCustomError(noblepay, "ZeroAddress");
    });

    it("should revert for self-payment", async function () {
      const { noblepay, usdc, business1 } = await loadFixture(deployFixture);
      await expect(noblepay.connect(business1).initiatePayment(
        business1.address, 100, usdc.target, ethers.ZeroHash, "0x555344"
      )).to.be.revertedWithCustomError(noblepay, "InvalidRecipient");
    });

    it("should revert for unsupported token", async function () {
      const { noblepay, business1, recipient, other } = await loadFixture(deployFixture);
      await expect(noblepay.connect(business1).initiatePayment(
        recipient.address, 100, other.address, ethers.ZeroHash, "0x555344"
      )).to.be.revertedWithCustomError(noblepay, "UnsupportedToken");
    });

    it("should revert for insufficient native payment", async function () {
      const { noblepay, business1, recipient } = await loadFixture(deployFixture);
      const amount = 1000n;
      await expect(noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, "0x414554",
        { value: 500n }
      )).to.be.revertedWithCustomError(noblepay, "InsufficientPayment");
    });
  });

  describe("Compliance", function () {
    async function paymentFixture() {
      const fixture = await loadFixture(deployFixture);
      const { noblepay, usdc, business1, recipient, teeNode } = fixture;
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];
      return { ...fixture, paymentId, amount };
    }

    it("should submit compliance result - PASSED", async function () {
      const { noblepay, teeNode, paymentId } = await paymentFixture();
      await expect(noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
      )).to.emit(noblepay, "PaymentCleared");
    });

    it("should flag payment with high AML score", async function () {
      const { noblepay, teeNode, paymentId } = await paymentFixture();
      await expect(noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 80, true, ethers.keccak256("0x01"), "0x1234"
      )).to.emit(noblepay, "PaymentFlagged");
    });

    it("should block payment with sanctions failure", async function () {
      const { noblepay, teeNode, paymentId } = await paymentFixture();
      await expect(noblepay.connect(teeNode).submitComplianceResult(
        paymentId, false, 10, true, ethers.keccak256("0x01"), "0x1234"
      )).to.emit(noblepay, "PaymentBlocked");
    });

    it("should revert for non-TEE node", async function () {
      const { noblepay, other, paymentId } = await paymentFixture();
      await expect(noblepay.connect(other).submitComplianceResult(
        paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
      )).to.be.reverted;
    });

    it("should revert for invalid risk score > 100", async function () {
      const { noblepay, teeNode, paymentId } = await paymentFixture();
      await expect(noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 101, true, ethers.ZeroHash, "0x1234"
      )).to.be.revertedWithCustomError(noblepay, "InvalidRiskScore");
    });

    it("should revert for non-existent payment", async function () {
      const { noblepay, teeNode } = await paymentFixture();
      await expect(noblepay.connect(teeNode).submitComplianceResult(
        ethers.ZeroHash, true, 30, true, ethers.ZeroHash, "0x1234"
      )).to.be.revertedWithCustomError(noblepay, "PaymentNotFound");
    });
  });

  describe("Settlement & Refund", function () {
    async function clearedPaymentFixture() {
      const fixture = await loadFixture(deployFixture);
      const { noblepay, usdc, business1, recipient, teeNode } = fixture;
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
      );
      return { ...fixture, paymentId, amount };
    }

    it("should settle a cleared payment", async function () {
      const { noblepay, paymentId } = await clearedPaymentFixture();
      await expect(noblepay.settlePayment(paymentId))
        .to.emit(noblepay, "PaymentSettled");
    });

    it("should revert settling a non-PASSED payment", async function () {
      const fixture = await loadFixture(deployFixture);
      const { noblepay, usdc, business1, recipient } = fixture;
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await expect(noblepay.settlePayment(paymentId))
        .to.be.revertedWithCustomError(noblepay, "InvalidPaymentStatus");
    });

    it("should refund a blocked payment", async function () {
      const fixture = await loadFixture(deployFixture);
      const { noblepay, usdc, business1, recipient, teeNode } = fixture;
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await noblepay.connect(teeNode).submitComplianceResult(
        paymentId, false, 10, true, ethers.keccak256("0x01"), "0x1234"
      );

      await expect(noblepay.refundPayment(paymentId))
        .to.emit(noblepay, "PaymentRefunded");
    });

    it("should cancel a pending payment by sender", async function () {
      const fixture = await loadFixture(deployFixture);
      const { noblepay, usdc, business1, recipient } = fixture;
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await expect(noblepay.connect(business1).cancelPayment(paymentId))
        .to.emit(noblepay, "PaymentRefunded");
    });

    it("should revert cancel by non-sender", async function () {
      const fixture = await loadFixture(deployFixture);
      const { noblepay, usdc, business1, recipient, other } = fixture;
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await expect(noblepay.connect(other).cancelPayment(paymentId))
        .to.be.revertedWith("NoblePay: not payment sender");
    });
  });

  describe("Admin Functions", function () {
    it("should set supported token", async function () {
      const { noblepay, admin, other } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).setSupportedToken(other.address, true))
        .to.emit(noblepay, "TokenSupported");
    });

    it("should revert setSupportedToken for zero address", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).setSupportedToken(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(noblepay, "ZeroAddress");
    });

    it("should update fees", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).setFees(100, 100))
        .to.emit(noblepay, "FeeUpdated");
    });

    it("should revert fee update exceeding max", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).setFees(100, 501))
        .to.be.revertedWithCustomError(noblepay, "InvalidFee");
    });

    it("should update treasury", async function () {
      const { noblepay, admin, other } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).setTreasury(other.address))
        .to.emit(noblepay, "TreasuryUpdated");
    });

    it("should sync business", async function () {
      const { noblepay, admin, other } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).syncBusiness(other.address, 1, true))
        .to.emit(noblepay, "BusinessSynced");
    });

    it("should pause and unpause", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await noblepay.connect(admin).pause();
      expect(await noblepay.paused()).to.be.true;
      await noblepay.connect(admin).unpause();
      expect(await noblepay.paused()).to.be.false;
    });

    it("should revert admin functions for non-admin", async function () {
      const { noblepay, other } = await loadFixture(deployFixture);
      await expect(noblepay.connect(other).pause()).to.be.reverted;
      await expect(noblepay.connect(other).setFees(0, 0)).to.be.reverted;
    });
  });

  describe("View Functions", function () {
    it("should return daily and monthly limits per tier", async function () {
      const { noblepay } = await loadFixture(deployFixture);
      expect(await noblepay.getDailyLimit(0)).to.equal(50000n * 1000000n);
      expect(await noblepay.getDailyLimit(1)).to.equal(500000n * 1000000n);
      expect(await noblepay.getDailyLimit(2)).to.equal(5000000n * 1000000n);
      expect(await noblepay.getMonthlyLimit(0)).to.equal(500000n * 1000000n);
    });
  });

  describe("Batch Payments", function () {
    it("should initiate a batch of payments", async function () {
      const { noblepay, usdc, business1, recipient, other } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      await expect(noblepay.connect(business1).initiatePaymentBatch(
        [recipient.address, other.address],
        [amount, amount],
        [usdc.target, usdc.target],
        [ethers.ZeroHash, ethers.ZeroHash],
        ["0x555344", "0x555344"]
      )).to.emit(noblepay, "BatchProcessed");
    });

    it("should revert empty batch", async function () {
      const { noblepay, business1 } = await loadFixture(deployFixture);
      await expect(noblepay.connect(business1).initiatePaymentBatch([], [], [], [], []))
        .to.be.revertedWithCustomError(noblepay, "BatchEmpty");
    });

    it("should revert array length mismatch", async function () {
      const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
      await expect(noblepay.connect(business1).initiatePaymentBatch(
        [recipient.address],
        [100, 200],
        [usdc.target],
        [ethers.ZeroHash],
        ["0x555344"]
      )).to.be.revertedWith("NoblePay: array length mismatch");
    });
  });
});
