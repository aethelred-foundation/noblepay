const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("NoblePay - Coverage", function () {
  async function deployFixture() {
    const [
      admin,
      treasury,
      teeNode,
      complianceOfficer,
      business1,
      business2,
      recipient,
      other,
    ] = await ethers.getSigners();

    const NoblePay = await ethers.getContractFactory("NoblePay");
    const baseFee = ethers.parseUnits("1", 6);
    const percentageFee = 50;
    const noblepay = await NoblePay.deploy(
      admin.address,
      treasury.address,
      baseFee,
      percentageFee,
    );

    const Registry = await ethers.getContractFactory("MockBusinessRegistry");
    const registry = await Registry.deploy();
    const Gate = await ethers.getContractFactory("MockSealSettlementGate");
    const gate = await Gate.deploy(true);
    await registry.setBusiness(business1.address, true, 0);
    await registry.setBusiness(business2.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const TEE_NODE_ROLE = await noblepay.TEE_NODE_ROLE();
    const COMPLIANCE_OFFICER_ROLE = await noblepay.COMPLIANCE_OFFICER_ROLE();
    await noblepay.connect(admin).grantRole(TEE_NODE_ROLE, teeNode.address);
    await noblepay
      .connect(admin)
      .grantRole(COMPLIANCE_OFFICER_ROLE, complianceOfficer.address);

    await noblepay.connect(admin).setSupportedToken(usdc.target, true);
    await noblepay.connect(admin).syncBusiness(business1.address, 0, true);
    await noblepay.connect(admin).syncBusiness(business2.address, 0, true);

    const amount = ethers.parseUnits("1000000", 6);
    await usdc.mint(business1.address, amount);
    await usdc.mint(business2.address, amount);
    await usdc.connect(business1).approve(noblepay.target, amount);
    await usdc.connect(business2).approve(noblepay.target, amount);

    return {
      noblepay,
      registry,
      gate,
      usdc,
      admin,
      treasury,
      teeNode,
      complianceOfficer,
      business1,
      business2,
      recipient,
      other,
    };
  }

  describe("Native Token Rejection", function () {
    it("should reject native value rather than trapping it", async function () {
      const { noblepay, business1, recipient } =
        await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      await expect(
        noblepay
          .connect(business1)
          .initiatePayment(
            recipient.address,
            amount,
            ethers.ZeroAddress,
            ethers.ZeroHash,
            "0x414554",
            { value: amount },
          ),
      ).to.be.revertedWithCustomError(noblepay, "UnexpectedNativeValue");
    });
  });

  describe("Refund Flagged Payment by Compliance Officer", function () {
    it("should refund a flagged payment by compliance officer", async function () {
      const {
        noblepay,
        usdc,
        teeNode,
        complianceOfficer,
        business1,
        recipient,
      } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      // Flag the payment (high AML score)
      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          paymentId,
          true,
          80,
          true,
          ethers.keccak256("0x01"),
          "0x1234",
        );

      // Compliance officer refunds
      await expect(
        noblepay.connect(complianceOfficer).refundPayment(paymentId),
      ).to.emit(noblepay, "PaymentRefunded");
    });

    it("should revert refund of FLAGGED by non-compliance officer", async function () {
      const { noblepay, usdc, teeNode, other, business1, recipient } =
        await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          paymentId,
          true,
          80,
          true,
          ethers.keccak256("0x01"),
          "0x1234",
        );

      await expect(
        noblepay.connect(other).refundPayment(paymentId),
      ).to.be.revertedWith("NoblePay: cannot refund this payment");
    });
  });

  describe("Compliance - travelRuleOk=false", function () {
    it("should flag payment when travel rule fails", async function () {
      const { noblepay, usdc, teeNode, business1, recipient } =
        await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      await expect(
        noblepay
          .connect(teeNode)
          .submitComplianceResult(
            paymentId,
            true,
            30,
            false,
            ethers.keccak256("0x01"),
            "0x1234",
          ),
      ).to.emit(noblepay, "PaymentFlagged");
    });
  });

  describe("Volume Limits", function () {
    it("should enforce daily volume limit for standard tier", async function () {
      const { noblepay, usdc, business1, recipient } =
        await loadFixture(deployFixture);
      // Standard daily limit is 50_000 * 1e6 = 50000000000
      const nearLimitAmount = ethers.parseUnits("49999", 6);
      await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          nearLimitAmount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );

      // Second payment should exceed
      const overAmount = ethers.parseUnits("2000", 6);
      await expect(
        noblepay
          .connect(business1)
          .initiatePayment(
            recipient.address,
            overAmount,
            usdc.target,
            ethers.ZeroHash,
            "0x555344",
          ),
      ).to.be.revertedWithCustomError(noblepay, "DailyLimitExceeded");
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
      const { noblepay, usdc, business1, recipient } =
        await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      const payment = await noblepay.getPayment(paymentId);
      expect(payment.sender).to.equal(business1.address);
    });

    it("should return compliance result", async function () {
      const { noblepay, usdc, teeNode, business1, recipient } =
        await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          paymentId,
          true,
          30,
          true,
          ethers.ZeroHash,
          "0x1234",
        );

      const result = await noblepay.getComplianceResult(paymentId);
      expect(result.sanctionsClear).to.be.true;
    });
  });

  describe("Batch Native Rejection", function () {
    it("should reject nonzero msg.value for a batch", async function () {
      const { noblepay, business1, recipient, other } =
        await loadFixture(deployFixture);
      const amount = 1000n;
      await expect(
        noblepay
          .connect(business1)
          .initiatePaymentBatch(
            [recipient.address, other.address],
            [amount, amount],
            [ethers.ZeroAddress, ethers.ZeroAddress],
            [ethers.ZeroHash, ethers.ZeroHash],
            ["0x414554", "0x414554"],
            { value: amount * 2n },
          ),
      ).to.be.revertedWithCustomError(noblepay, "UnexpectedNativeValue");
    });

    it("should reject native token entries without msg.value", async function () {
      const { noblepay, business1, recipient, other } =
        await loadFixture(deployFixture);
      const amount = 1000n;
      await expect(
        noblepay
          .connect(business1)
          .initiatePaymentBatch(
            [recipient.address, other.address],
            [amount, amount],
            [ethers.ZeroAddress, ethers.ZeroAddress],
            [ethers.ZeroHash, ethers.ZeroHash],
            ["0x414554", "0x414554"],
          ),
      ).to.be.revertedWithCustomError(noblepay, "NativePaymentsDisabled");
    });
  });

  describe("Settle with zero fee", function () {
    it("should settle payment when baseFee and percentageFee are zero", async function () {
      const { noblepay, usdc, admin, teeNode, business1, recipient, treasury } =
        await loadFixture(deployFixture);
      // Set fees to zero
      await noblepay.connect(admin).setFees(0, 0);

      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          paymentId,
          true,
          30,
          true,
          ethers.ZeroHash,
          "0x1234",
        );

      await expect(noblepay.settlePayment(paymentId)).to.emit(
        noblepay,
        "PaymentSettled",
      );
    });
  });

  describe("Treasury Update", function () {
    it("should revert setTreasury with zero address", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await expect(
        noblepay.connect(admin).setTreasury(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(noblepay, "ZeroAddress");
    });
  });

  describe("Cancel non-PENDING", function () {
    it("should revert cancel of non-PENDING payment", async function () {
      const { noblepay, usdc, teeNode, business1, recipient } =
        await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      const tx = await noblepay
        .connect(business1)
        .initiatePayment(
          recipient.address,
          amount,
          usdc.target,
          ethers.ZeroHash,
          "0x555344",
        );
      const receipt = await tx.wait();
      const event = receipt.logs.find(
        (l) => l.fragment && l.fragment.name === "PaymentInitiated",
      );
      const paymentId = event.args[0];

      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          paymentId,
          true,
          30,
          true,
          ethers.ZeroHash,
          "0x1234",
        );

      await expect(
        noblepay.connect(business1).cancelPayment(paymentId),
      ).to.be.revertedWithCustomError(noblepay, "InvalidPaymentStatus");
    });
  });

  describe("Receive Native", function () {
    it("should reject direct native tokens", async function () {
      const { noblepay, admin } = await loadFixture(deployFixture);
      await expect(
        admin.sendTransaction({
          to: noblepay.target,
          value: ethers.parseEther("1"),
        }),
      ).to.be.revertedWithCustomError(noblepay, "UnexpectedNativeValue");
    });
  });
});
