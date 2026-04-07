import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const { loadFixture, time } = networkHelpers;

describe("NoblePay - Coverage", function () {
  async function deployFixture() {
    const [admin, treasury, teeNode, complianceOfficer, business1, business2, recipient, other] = await ethers.getSigners();

    const NoblePay = await ethers.getContractFactory("NoblePay");
    const baseFee = ethers.parseUnits("1", 6);
    const percentageFee = 50;
    const noblepay = await NoblePay.deploy(admin.address, treasury.address, baseFee, percentageFee);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const TEE_NODE_ROLE = await noblepay.TEE_NODE_ROLE();
    const COMPLIANCE_OFFICER_ROLE = await noblepay.COMPLIANCE_OFFICER_ROLE();
    await noblepay.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await noblepay.connect(admin).grantRole(COMPLIANCE_OFFICER_ROLE, complianceOfficer.address);

    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true);
    await noblepay.connect(admin).syncBusiness(business2.address, 0, true);

    const amount = ethers.parseUnits("1000000", 6);
    await usdc.mint(business1.address, amount);
    await usdc.mint(business2.address, amount);
    await usdc.connect(business1).approve(noblepay.target, amount);
    await usdc.connect(business2).approve(noblepay.target, amount);

    return { noblepay, usdc, admin, treasury, teeNode, complianceOfficer, business1, business2, recipient, other };
  }

  describe("Settlement with Native Tokens", function () {
    it("should settle a native payment", async function () {
      const { noblepay, admin, teeNode, business1, recipient, treasury } = await loadFixture(deployFixture);
      await noblepay.connect(admin).syncBusiness(business1.address, 0, true);

      // Amount must be > baseFee (1e6) to avoid underflow
      const amount = ethers.parseUnits("100", 6); // 100 USDC equivalent
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, "0x414554",
        { value: amount }
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 30, true, ethers.ZeroHash, "0x1234"
      );

      const balBefore = await ethers.provider.getBalance(recipient.address);
      await noblepay.settlePayment(paymentId);
      const balAfter = await ethers.provider.getBalance(recipient.address);
      expect(balAfter).to.be.greaterThan(balBefore);
    });
  });

  describe("Refund Flagged Payment by Compliance Officer", function () {
    it("should refund a flagged payment by compliance officer", async function () {
      const { noblepay, usdc, teeNode, complianceOfficer, business1, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      // Flag the payment (high AML score)
      await noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 80, true, ethers.keccak256("0x01"), "0x1234"
      );

      // Compliance officer refunds
      await expect(noblepay.connect(complianceOfficer).refundPayment(paymentId))
        .to.emit(noblepay, "PaymentRefunded");
    });

    it("should revert refund of FLAGGED by non-compliance officer", async function () {
      const { noblepay, usdc, teeNode, other, business1, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 80, true, ethers.keccak256("0x01"), "0x1234"
      );

      await expect(noblepay.connect(other).refundPayment(paymentId))
        .to.be.revertedWith("NoblePay: cannot refund this payment");
    });
  });

  describe("Refund Native Payment", function () {
    it("should refund a blocked native payment", async function () {
      const { noblepay, admin, teeNode, business1, recipient } = await loadFixture(deployFixture);
      const amount = 10000n;
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, "0x414554",
        { value: amount }
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await noblepay.connect(teeNode).submitComplianceResult(
        paymentId, false, 10, true, ethers.keccak256("0x01"), "0x1234"
      );

      const balBefore = await ethers.provider.getBalance(business1.address);
      await noblepay.refundPayment(paymentId);
      const balAfter = await ethers.provider.getBalance(business1.address);
      expect(balAfter).to.be.greaterThan(balBefore);
    });
  });

  describe("Cancel Native Payment", function () {
    it("should cancel a native pending payment", async function () {
      const { noblepay, business1, recipient } = await loadFixture(deployFixture);
      const amount = 10000n;
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, ethers.ZeroAddress, ethers.ZeroHash, "0x414554",
        { value: amount }
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await expect(noblepay.connect(business1).cancelPayment(paymentId))
        .to.emit(noblepay, "PaymentRefunded");
    });
  });

  describe("Compliance - travelRuleOk=false", function () {
    it("should flag payment when travel rule fails", async function () {
      const { noblepay, usdc, teeNode, business1, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      await expect(noblepay.connect(teeNode).submitComplianceResult(
        paymentId, true, 30, false, ethers.keccak256("0x01"), "0x1234"
      )).to.emit(noblepay, "PaymentFlagged");
    });
  });

  describe("Volume Limits", function () {
    it("should enforce daily volume limit for standard tier", async function () {
      const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
      // Standard daily limit is 50_000 * 1e6 = 50000000000
      const nearLimitAmount = ethers.parseUnits("49999", 6);
      await noblepay.connect(business1).initiatePayment(
        recipient.address, nearLimitAmount, usdc.target, ethers.ZeroHash, "0x555344"
      );

      // Second payment should exceed
      const overAmount = ethers.parseUnits("2000", 6);
      await expect(noblepay.connect(business1).initiatePayment(
        recipient.address, overAmount, usdc.target, ethers.ZeroHash, "0x555344"
      )).to.be.revertedWithCustomError(noblepay, "DailyLimitExceeded");
    });
  });

  describe("Tier Limits", function () {
    it("should return premium monthly limit", async function () {
      const { noblepay } = await loadFixture(deployFixture);
      expect(await noblepay.getMonthlyLimit(1)).to.equal(5000000n * 1000000n); // PREMIUM
    });

    it("should return enterprise monthly limit", async function () {
      const { noblepay } = await loadFixture(deployFixture);
      expect(await noblepay.getMonthlyLimit(2)).to.equal(50000000n * 1000000n); // ENTERPRISE
    });
  });

  describe("View Functions", function () {
    it("should return payment via getPayment", async function () {
      const { noblepay, usdc, business1, recipient } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay.connect(business1).initiatePayment(
        recipient.address, amount, usdc.target, ethers.ZeroHash, "0x555344"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment && l.fragment.name === "PaymentInitiated");
      const paymentId = event.args[0];

      const payment = await noblepay.getPayment(paymentId);
      expect(payment.sender).to.equal(business1.address);
    });

    it("should return compliance result", async function () {
      const { noblepay, usdc, teeNode, business1, recipient } = await loadFixture(deployFixture);
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

      const result = await noblepay.getComplianceResult(paymentId);
      expect(result.sanctionsClear).to.be.true;
    });
  });

  describe("Batch with Native Payments", function () {
    it("should initiate batch with native token payments", async function () {
      const { noblepay, admin, business1, recipient, other } = await loadFixture(deployFixture);
      const amount = 1000n;
      await expect(noblepay.connect(business1).initiatePaymentBatch(
        [recipient.address, other.address],
        [amount, amount],
        [ethers.ZeroAddress, ethers.ZeroAddress],
        [ethers.ZeroHash, ethers.ZeroHash],
        ["0x414554", "0x414554"],
        { value: amount * 2n }
      )).to.emit(noblepay, "BatchProcessed");
    });

    it("should revert batch with insufficient native value", async function () {
      const { noblepay, business1, recipient, other } = await loadFixture(deployFixture);
      const amount = 1000n;
      await expect(noblepay.connect(business1).initiatePaymentBatch(
        [recipient.address, other.address],
        [amount, amount],
        [ethers.ZeroAddress, ethers.ZeroAddress],
        [ethers.ZeroHash, ethers.ZeroHash],
        ["0x414554", "0x414554"],
        { value: amount } // only half
      )).to.be.revertedWithCustomError(noblepay, "InsufficientPayment");
    });
  });

  describe("Settle with zero fee", function () {
    it("should settle payment when baseFee and percentageFee are zero", async function () {
      const { noblepay, usdc, admin, teeNode, business1, recipient, treasury } = await loadFixture(deployFixture);
      // Set fees to zero
      await noblepay.connect(admin).setFees(0, 0);

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

      await expect(noblepay.settlePayment(paymentId))
        .to.emit(noblepay, "PaymentSettled");
    });
  });

  describe("Treasury Update", function () {
    it("should revert setTreasury with zero address", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await expect(noblepay.connect(admin).setTreasury(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(noblepay, "ZeroAddress");
    });
  });

  describe("Cancel non-PENDING", function () {
    it("should revert cancel of non-PENDING payment", async function () {
      const { noblepay, usdc, teeNode, business1, recipient } = await loadFixture(deployFixture);
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

      await expect(noblepay.connect(business1).cancelPayment(paymentId))
        .to.be.revertedWithCustomError(noblepay, "InvalidPaymentStatus");
    });
  });

  describe("Receive Native", function () {
    it("should accept native tokens", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await admin.sendTransaction({ to: noblepay.target, value: ethers.parseEther("1") });
    });
  });
});
