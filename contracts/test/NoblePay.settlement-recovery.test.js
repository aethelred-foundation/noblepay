const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
  time,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("NoblePay settlement recovery", function () {
  async function deployFixture() {
    const [
      admin,
      treasury,
      teeNode,
      complianceOfficer,
      sender,
      recipient,
      outsider,
    ] = await ethers.getSigners();

    const NoblePay = await ethers.getContractFactory("NoblePay");
    const noblepay = await NoblePay.deploy(
      admin.address,
      treasury.address,
      ethers.parseUnits("1", 6),
      50
    );

    const Registry = await ethers.getContractFactory("MockBusinessRegistry");
    const registry = await Registry.deploy();
    await registry.setBusiness(sender.address, true, 0);

    const Gate = await ethers.getContractFactory("SealSettlementGate");
    const gate = await Gate.deploy(admin.address);

    const MockSeal = await ethers.getContractFactory("MockISeal");
    const deployedSeal = await MockSeal.deploy();
    const sealAddress = "0x0000000000000000000000000000000000000900";
    await ethers.provider.send("hardhat_setCode", [
      sealAddress,
      await ethers.provider.getCode(deployedSeal.target),
    ]);
    const seal = await ethers.getContractAt("MockISeal", sealAddress);
    await seal.setPolicyResult(true, "");

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("USD Coin", "USDC", 6);
    await token.mint(sender.address, ethers.parseUnits("1000000", 6));
    await token.connect(sender).approve(noblepay.target, ethers.MaxUint256);

    await noblepay
      .connect(admin)
      .grantRole(await noblepay.TEE_NODE_ROLE(), teeNode.address);
    await noblepay
      .connect(admin)
      .grantRole(
        await noblepay.COMPLIANCE_OFFICER_ROLE(),
        complianceOfficer.address
      );
    await noblepay.connect(admin).setSupportedToken(token.target, true);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    async function createPendingPayment() {
      const amount = ethers.parseUnits("100", 6);
      const openingBalance = await token.balanceOf(sender.address);
      const tx = await noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344"
        );
      const receipt = await tx.wait();
      const paymentId = receipt.logs.find(
        (log) => log.fragment?.name === "PaymentInitiated"
      ).args.paymentId;
      return { paymentId, amount, openingBalance };
    }

    async function createPassedPayment() {
      const pending = await createPendingPayment();
      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          pending.paymentId,
          true,
          10,
          true,
          ethers.ZeroHash,
          "0x1234"
        );
      return pending;
    }

    async function createBlockedPayment() {
      const pending = await createPendingPayment();
      await noblepay
        .connect(teeNode)
        .submitComplianceResult(
          pending.paymentId,
          false,
          10,
          true,
          ethers.ZeroHash,
          "0x1234"
        );
      return pending;
    }

    async function clearCorridor(label) {
      const purpose = await gate.expectedPurpose(
        sender.address,
        recipient.address
      );
      await seal.setSeal(
        `settlement-recovery-job-${label}`,
        `settlement-recovery-seal-${label}`,
        purpose,
        true
      );
      await gate.clear(
        sender.address,
        recipient.address,
        `settlement-recovery-job-${label}`
      );
    }

    return {
      admin,
      treasury,
      teeNode,
      complianceOfficer,
      sender,
      recipient,
      outsider,
      noblepay,
      registry,
      gate,
      seal,
      token,
      createPendingPayment,
      createPassedPayment,
      createBlockedPayment,
      clearCorridor,
    };
  }

  async function advanceToExecution(noblepay, paymentId) {
    const request = await noblepay.settlementRecoveryRequests(paymentId);
    await time.increaseTo(request.executeAfter);
    return request;
  }

  it("keeps sender and compliance refund exits available during an indefinite pause", async function () {
    const {
      admin,
      complianceOfficer,
      sender,
      outsider,
      noblepay,
      token,
      createPendingPayment,
      createBlockedPayment,
      createPassedPayment,
    } = await loadFixture(deployFixture);

    const pending = await createPendingPayment();
    await noblepay.connect(admin).pause();
    await expect(
      noblepay.connect(sender).cancelPayment(pending.paymentId)
    ).to.emit(noblepay, "PaymentRefunded");
    expect(await token.balanceOf(sender.address)).to.equal(
      pending.openingBalance
    );

    await noblepay.connect(admin).unpause();
    const blocked = await createBlockedPayment();
    await noblepay.connect(admin).pause();
    await expect(
      noblepay.connect(outsider).refundPayment(blocked.paymentId)
    ).to.emit(noblepay, "PaymentRefunded");
    expect(await token.balanceOf(sender.address)).to.equal(
      blocked.openingBalance
    );

    await noblepay.connect(admin).unpause();
    const passed = await createPassedPayment();
    await noblepay.connect(admin).pause();
    await expect(
      noblepay
        .connect(complianceOfficer)
        .requestSettlementRecovery(passed.paymentId)
    ).to.emit(noblepay, "SettlementRecoveryRequested");
    await advanceToExecution(noblepay, passed.paymentId);
    await expect(
      noblepay
        .connect(complianceOfficer)
        .executeSettlementRecovery(passed.paymentId)
    ).to.emit(noblepay, "SettlementRecoveryExecuted");
    expect(await noblepay.paused()).to.equal(true);
    expect(await token.balanceOf(sender.address)).to.equal(
      passed.openingBalance
    );
  });

  it("recovers a cleared PASSED payment if the core pause outlives the notice period", async function () {
    const {
      admin,
      complianceOfficer,
      sender,
      noblepay,
      token,
      createPassedPayment,
      clearCorridor,
    } = await loadFixture(deployFixture);
    const payment = await createPassedPayment();
    await clearCorridor("core-pause-exit");
    await noblepay.connect(admin).pause();

    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(payment.paymentId);
    await advanceToExecution(noblepay, payment.paymentId);
    await expect(
      noblepay
        .connect(complianceOfficer)
        .executeSettlementRecovery(payment.paymentId)
    ).to.emit(noblepay, "SettlementRecoveryExecuted");

    expect(await noblepay.paused()).to.equal(true);
    expect((await noblepay.getPayment(payment.paymentId)).status).to.equal(5);
    expect(await token.balanceOf(sender.address)).to.equal(
      payment.openingBalance
    );
  });

  it("cancels core-pause recovery if unpause restores normal settlement", async function () {
    const {
      admin,
      complianceOfficer,
      noblepay,
      createPassedPayment,
      clearCorridor,
    } = await loadFixture(deployFixture);
    const payment = await createPassedPayment();
    await clearCorridor("core-pause-restored");
    await noblepay.connect(admin).pause();
    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(payment.paymentId);
    await advanceToExecution(noblepay, payment.paymentId);

    await noblepay.connect(admin).unpause();
    await expect(
      noblepay
        .connect(complianceOfficer)
        .executeSettlementRecovery(payment.paymentId)
    ).to.be.revertedWithCustomError(noblepay, "SettlementStillAvailable");
  });

  it("denies recovery for a valid, settleable corridor", async function () {
    const { complianceOfficer, noblepay, createPassedPayment, clearCorridor } =
      await loadFixture(deployFixture);
    const { paymentId } = await createPassedPayment();
    await clearCorridor("valid-denial");

    await expect(
      noblepay.connect(complianceOfficer).requestSettlementRecovery(paymentId)
    ).to.be.revertedWithCustomError(noblepay, "SettlementStillAvailable");
    expect(
      (await noblepay.settlementRecoveryRequests(paymentId)).executeAfter
    ).to.equal(0);
  });

  it("enforces authorization and the delay before exactly refunding missing-clearance escrow", async function () {
    const {
      treasury,
      complianceOfficer,
      sender,
      recipient,
      outsider,
      noblepay,
      token,
      createPassedPayment,
    } = await loadFixture(deployFixture);
    const { paymentId, amount, openingBalance } = await createPassedPayment();

    await expect(
      noblepay.connect(outsider).requestSettlementRecovery(paymentId)
    ).to.be.reverted;
    await expect(
      noblepay.connect(complianceOfficer).requestSettlementRecovery(paymentId)
    ).to.emit(noblepay, "SettlementRecoveryRequested");

    const request = await noblepay.settlementRecoveryRequests(paymentId);
    expect(request.requestedBy).to.equal(complianceOfficer.address);
    expect(request.expiresAt - request.executeAfter).to.equal(
      await noblepay.SETTLEMENT_RECOVERY_WINDOW()
    );
    await expect(
      noblepay.connect(complianceOfficer).requestSettlementRecovery(paymentId)
    )
      .to.be.revertedWithCustomError(
        noblepay,
        "SettlementRecoveryAlreadyRequested"
      )
      .withArgs(request.expiresAt);
    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    )
      .to.be.revertedWithCustomError(
        noblepay,
        "SettlementRecoveryDelayNotElapsed"
      )
      .withArgs(request.executeAfter);

    await time.increaseTo(request.executeAfter);
    await expect(
      noblepay.connect(outsider).executeSettlementRecovery(paymentId)
    ).to.be.reverted;
    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    )
      .to.emit(noblepay, "SettlementRecoveryExecuted")
      .and.to.emit(noblepay, "PaymentRefunded");

    expect((await noblepay.getPayment(paymentId)).status).to.equal(5);
    expect(await token.balanceOf(sender.address)).to.equal(openingBalance);
    expect(await token.balanceOf(recipient.address)).to.equal(0);
    expect(await token.balanceOf(treasury.address)).to.equal(0);
    expect(await token.balanceOf(noblepay.target)).to.equal(0);
    expect(amount).to.equal(ethers.parseUnits("100", 6));
    expect(
      (await noblepay.settlementRecoveryRequests(paymentId)).executeAfter
    ).to.equal(0);

    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    ).to.be.revertedWithCustomError(noblepay, "InvalidPaymentStatus");
  });

  it("recovers after a live clearance is locally revoked", async function () {
    const {
      admin,
      complianceOfficer,
      sender,
      recipient,
      noblepay,
      gate,
      token,
      createPassedPayment,
      clearCorridor,
    } = await loadFixture(deployFixture);
    const { paymentId, openingBalance } = await createPassedPayment();
    await clearCorridor("revoked");
    await gate.connect(admin).revoke(sender.address, recipient.address);

    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(paymentId);
    await advanceToExecution(noblepay, paymentId);
    await noblepay
      .connect(complianceOfficer)
      .executeSettlementRecovery(paymentId);

    expect((await noblepay.getPayment(paymentId)).status).to.equal(5);
    expect(await token.balanceOf(sender.address)).to.equal(openingBalance);
    expect(await token.balanceOf(recipient.address)).to.equal(0);
  });

  it("recovers while the Seal gate remains paused", async function () {
    const {
      admin,
      complianceOfficer,
      sender,
      noblepay,
      gate,
      token,
      createPassedPayment,
      clearCorridor,
    } = await loadFixture(deployFixture);
    const { paymentId, openingBalance } = await createPassedPayment();
    await clearCorridor("paused-recovery");
    await gate.connect(admin).pause();

    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(paymentId);
    await advanceToExecution(noblepay, paymentId);
    await noblepay
      .connect(complianceOfficer)
      .executeSettlementRecovery(paymentId);

    expect((await noblepay.getPayment(paymentId)).status).to.equal(5);
    expect(await token.balanceOf(sender.address)).to.equal(openingBalance);
  });

  it("cannot front-run restored clearance and normal settlement invalidates recovery", async function () {
    const {
      admin,
      treasury,
      complianceOfficer,
      recipient,
      noblepay,
      gate,
      token,
      createPassedPayment,
      clearCorridor,
    } = await loadFixture(deployFixture);
    const { paymentId, amount } = await createPassedPayment();
    await clearCorridor("restored");
    await gate.connect(admin).pause();
    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(paymentId);
    await advanceToExecution(noblepay, paymentId);

    await gate.connect(admin).unpause();
    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    ).to.be.revertedWithCustomError(noblepay, "SettlementStillAvailable");

    const fee = await noblepay.paymentFees(paymentId);
    await expect(noblepay.settlePayment(paymentId)).to.emit(
      noblepay,
      "PaymentSettled"
    );
    expect(await token.balanceOf(recipient.address)).to.equal(amount - fee);
    expect(await token.balanceOf(treasury.address)).to.equal(fee);
    expect(
      (await noblepay.settlementRecoveryRequests(paymentId)).executeAfter
    ).to.equal(0);
    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    ).to.be.revertedWithCustomError(noblepay, "InvalidPaymentStatus");
  });

  it("expires stale recovery authority and requires a fresh delay", async function () {
    const { complianceOfficer, noblepay, createPassedPayment } =
      await loadFixture(deployFixture);
    const { paymentId } = await createPassedPayment();

    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(paymentId);
    const first = await noblepay.settlementRecoveryRequests(paymentId);
    await time.increaseTo(first.expiresAt + 1n);
    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    )
      .to.be.revertedWithCustomError(
        noblepay,
        "SettlementRecoveryRequestExpired"
      )
      .withArgs(first.expiresAt);

    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(paymentId);
    const second = await noblepay.settlementRecoveryRequests(paymentId);
    expect(second.executeAfter).to.be.greaterThan(first.expiresAt);
    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    ).to.be.revertedWithCustomError(
      noblepay,
      "SettlementRecoveryDelayNotElapsed"
    );
  });

  it("routes an inactive sender through the existing immediate officer refund", async function () {
    const {
      complianceOfficer,
      sender,
      noblepay,
      registry,
      createPassedPayment,
    } = await loadFixture(deployFixture);
    const { paymentId } = await createPassedPayment();
    await noblepay
      .connect(complianceOfficer)
      .requestSettlementRecovery(paymentId);
    await advanceToExecution(noblepay, paymentId);
    await registry.setBusiness(sender.address, false, 0);

    await expect(
      noblepay.connect(complianceOfficer).executeSettlementRecovery(paymentId)
    ).to.be.revertedWithCustomError(
      noblepay,
      "SettlementRecoveryRequiresActiveSender"
    );
    await noblepay.connect(complianceOfficer).refundPayment(paymentId);
    expect(
      (await noblepay.settlementRecoveryRequests(paymentId)).executeAfter
    ).to.equal(0);
  });
});
