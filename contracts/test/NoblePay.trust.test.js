const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("NoblePay production trust boundary", function () {
  async function deployMocksFixture() {
    const [admin, treasury, teeNode, sender, recipient, other] =
      await ethers.getSigners();
    const NoblePay = await ethers.getContractFactory("NoblePay");
    const noblepay = await NoblePay.deploy(
      admin.address,
      treasury.address,
      0,
      0,
    );
    const Registry = await ethers.getContractFactory("MockBusinessRegistry");
    const registry = await Registry.deploy();
    const Gate = await ethers.getContractFactory("MockSealSettlementGate");
    const gate = await Gate.deploy(false);
    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("USD Coin", "USDC", 6);

    await noblepay
      .connect(admin)
      .grantRole(await noblepay.TEE_NODE_ROLE(), teeNode.address);
    await noblepay.connect(admin).setSupportedToken(token.target, true);
    await token.mint(sender.address, ethers.parseUnits("1000000", 6));
    await token.connect(sender).approve(noblepay.target, ethers.MaxUint256);

    return {
      admin,
      treasury,
      teeNode,
      sender,
      recipient,
      other,
      noblepay,
      registry,
      gate,
      token,
    };
  }

  async function paymentId(tx) {
    const receipt = await tx.wait();
    return receipt.logs.find((log) => log.fragment?.name === "PaymentInitiated")
      .args.paymentId;
  }

  it("fails closed before trust is configured and legacy sync cannot bypass it", async function () {
    const { admin, sender, recipient, noblepay, token } =
      await loadFixture(deployMocksFixture);
    await noblepay.connect(admin).syncBusiness(sender.address, 2, true);

    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          ethers.parseUnits("10", 6),
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    ).to.be.revertedWithCustomError(noblepay, "TrustNotConfigured");
  });

  it("accepts nonzero contract dependencies exactly once", async function () {
    const { admin, other, noblepay, registry, gate } =
      await loadFixture(deployMocksFixture);

    await expect(
      noblepay.connect(other).configureTrust(registry.target, gate.target),
    ).to.be.reverted;
    await expect(
      noblepay.connect(admin).configureTrust(ethers.ZeroAddress, gate.target),
    ).to.be.revertedWithCustomError(noblepay, "InvalidTrustContract");
    await expect(
      noblepay.connect(admin).configureTrust(other.address, gate.target),
    ).to.be.revertedWithCustomError(noblepay, "InvalidTrustContract");
    await expect(
      noblepay.connect(admin).configureTrust(registry.target, gate.target),
    )
      .to.emit(noblepay, "TrustConfigured")
      .withArgs(registry.target, gate.target);
    await expect(
      noblepay.connect(admin).configureTrust(registry.target, gate.target),
    ).to.be.revertedWithCustomError(noblepay, "TrustAlreadyConfigured");
  });

  it("sources active status and tier live from the registry", async function () {
    const { admin, sender, recipient, noblepay, registry, gate, token } =
      await loadFixture(deployMocksFixture);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);
    await noblepay.connect(admin).syncBusiness(sender.address, 2, true);

    const amount = ethers.parseUnits("51000", 6);
    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    ).to.be.revertedWithCustomError(noblepay, "NotRegisteredBusiness");

    await registry.setBusiness(sender.address, true, 0);
    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    ).to.be.revertedWithCustomError(noblepay, "DailyLimitExceeded");

    await registry.setBusiness(sender.address, true, 1);
    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    ).to.emit(noblepay, "PaymentInitiated");
  });

  it("uses the real BusinessRegistry ABI for active KYC and tier lookup", async function () {
    const { admin, sender, recipient, other, noblepay, gate, token } =
      await loadFixture(deployMocksFixture);
    const Registry = await ethers.getContractFactory("BusinessRegistry");
    const registry = await Registry.deploy(admin.address);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    await registry
      .connect(sender)
      .registerBusiness("DMCC-12345", "Acme Trading", 0, other.address);
    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          1000,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    ).to.be.revertedWithCustomError(noblepay, "NotRegisteredBusiness");

    await registry.connect(admin).verifyBusiness(sender.address);
    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          1000,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    ).to.emit(noblepay, "PaymentInitiated");
  });

  it("rechecks the ordered seal corridor immediately before settlement", async function () {
    const {
      admin,
      teeNode,
      sender,
      recipient,
      noblepay,
      registry,
      gate,
      token,
    } = await loadFixture(deployMocksFixture);
    await registry.setBusiness(sender.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    const amount = ethers.parseUnits("100", 6);
    const id = await paymentId(
      await noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    );
    await noblepay
      .connect(teeNode)
      .submitComplianceResult(id, true, 10, true, ethers.ZeroHash, "0x1234");

    await expect(noblepay.settlePayment(id)).to.be.revertedWithCustomError(
      gate,
      "CorridorNotCleared",
    );
    expect((await noblepay.getPayment(id)).status).to.equal(1);
    expect(await token.balanceOf(recipient.address)).to.equal(0);

    await gate.setCleared(recipient.address, sender.address, true);
    await expect(noblepay.settlePayment(id)).to.be.revertedWithCustomError(
      gate,
      "CorridorNotCleared",
    );

    await gate.setCleared(sender.address, recipient.address, true);
    await expect(noblepay.settlePayment(id)).to.emit(
      noblepay,
      "PaymentSettled",
    );
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
  });

  it("blocks settlement after registry deactivation and lets only an officer recover PASSED escrow", async function () {
    const {
      admin,
      teeNode,
      sender,
      recipient,
      other,
      noblepay,
      registry,
      gate,
      token,
    } = await loadFixture(deployMocksFixture);
    await registry.setBusiness(sender.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    const amount = ethers.parseUnits("100", 6);
    const openingBalance = await token.balanceOf(sender.address);
    const id = await paymentId(
      await noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    );
    await noblepay
      .connect(teeNode)
      .submitComplianceResult(id, true, 10, true, ethers.ZeroHash, "0x1234");
    await gate.setCleared(sender.address, recipient.address, true);
    await noblepay
      .connect(admin)
      .grantRole(await noblepay.COMPLIANCE_OFFICER_ROLE(), other.address);

    await expect(noblepay.connect(other).refundPayment(id)).to.be.revertedWith(
      "NoblePay: cannot refund this payment",
    );

    await registry.setBusiness(sender.address, false, 0);
    await expect(noblepay.settlePayment(id)).to.be.revertedWithCustomError(
      noblepay,
      "NotRegisteredBusiness",
    );
    await expect(
      noblepay.connect(recipient).refundPayment(id),
    ).to.be.revertedWith("NoblePay: cannot refund this payment");
    await expect(noblepay.connect(other).refundPayment(id)).to.emit(
      noblepay,
      "PaymentRefunded",
    );

    expect((await noblepay.getPayment(id)).status).to.equal(5);
    expect(await token.balanceOf(sender.address)).to.equal(openingBalance);
    expect(await token.balanceOf(recipient.address)).to.equal(0);
  });

  it("halts NoblePay settlement while the live Seal gate is paused", async function () {
    const { admin, teeNode, sender, recipient, noblepay, registry, token } =
      await loadFixture(deployMocksFixture);
    const Gate = await ethers.getContractFactory("SealSettlementGate");
    const liveGate = await Gate.deploy(admin.address);
    const MockSeal = await ethers.getContractFactory("MockISeal");
    const mockSeal = await MockSeal.deploy();
    const sealAddress = "0x0000000000000000000000000000000000000900";
    await ethers.provider.send("hardhat_setCode", [
      sealAddress,
      await ethers.provider.getCode(mockSeal.target),
    ]);
    const seal = await ethers.getContractAt("MockISeal", sealAddress);
    await seal.setPolicyResult(true, "");

    await registry.setBusiness(sender.address, true, 0);
    await noblepay
      .connect(admin)
      .configureTrust(registry.target, liveGate.target);
    const amount = ethers.parseUnits("100", 6);
    const id = await paymentId(
      await noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    );
    await noblepay
      .connect(teeNode)
      .submitComplianceResult(id, true, 10, true, ethers.ZeroHash, "0x1234");
    const purpose = await liveGate.expectedPurpose(
      sender.address,
      recipient.address,
    );
    await seal.setSeal("trust-pause-job", "trust-pause-seal", purpose, true);
    await liveGate.clear(sender.address, recipient.address, "trust-pause-job");

    await liveGate.connect(admin).pause();
    await expect(noblepay.settlePayment(id)).to.be.revertedWith(
      "Pausable: paused",
    );
    expect((await noblepay.getPayment(id)).status).to.equal(1);
    expect(await token.balanceOf(recipient.address)).to.equal(0);

    await liveGate.connect(admin).unpause();
    await expect(noblepay.settlePayment(id)).to.emit(
      noblepay,
      "PaymentSettled",
    );
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
  });

  it("treats verifier evidence as opaque bytes and relies on the governed submitter role", async function () {
    const {
      admin,
      teeNode,
      sender,
      recipient,
      other,
      noblepay,
      registry,
      gate,
      token,
    } = await loadFixture(deployMocksFixture);
    await registry.setBusiness(sender.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    const id = await paymentId(
      await noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          ethers.parseUnits("100", 6),
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    );
    const opaqueEvidence = "0x01020304";

    await expect(
      noblepay
        .connect(other)
        .submitComplianceResult(
          id,
          true,
          10,
          true,
          ethers.ZeroHash,
          opaqueEvidence,
        ),
    ).to.be.reverted;

    await noblepay
      .connect(teeNode)
      .submitComplianceResult(
        id,
        true,
        10,
        true,
        ethers.ZeroHash,
        opaqueEvidence,
      );

    const payment = await noblepay.getPayment(id);
    expect(payment.status).to.equal(1);
    expect(payment.teeAttestation).to.equal(opaqueEvidence);
  });

  it("rejects non-6-decimal assets so volume limits and flat fees have one unit", async function () {
    const { admin, noblepay } = await loadFixture(deployMocksFixture);
    const Token = await ethers.getContractFactory("MockERC20");
    const eighteenDecimalToken = await Token.deploy("Wrapped AET", "WAET", 18);

    await expect(
      noblepay
        .connect(admin)
        .setSupportedToken(eighteenDecimalToken.target, true),
    )
      .to.be.revertedWithCustomError(noblepay, "InvalidTokenDecimals")
      .withArgs(eighteenDecimalToken.target, 18);
  });

  it("rejects native value on ERC20 initiation instead of trapping an overpayment", async function () {
    const { admin, sender, recipient, noblepay, registry, gate, token } =
      await loadFixture(deployMocksFixture);
    await registry.setBusiness(sender.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);

    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          ethers.parseUnits("100", 6),
          token.target,
          ethers.ZeroHash,
          "0x555344",
          { value: 1 },
        ),
    )
      .to.be.revertedWithCustomError(noblepay, "UnexpectedNativeValue")
      .withArgs(1);
  });

  it("rejects a fee equal to the payment for single and batch initiation", async function () {
    const { admin, sender, recipient, other, noblepay, registry, gate, token } =
      await loadFixture(deployMocksFixture);
    await registry.setBusiness(sender.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);
    await noblepay.connect(admin).setFees(100, 0);

    await expect(
      noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          100,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    )
      .to.be.revertedWithCustomError(noblepay, "FeeNotLessThanAmount")
      .withArgs(100, 100);

    await expect(
      noblepay
        .connect(sender)
        .initiatePaymentBatch(
          [recipient.address, other.address],
          [101, 100],
          [token.target, token.target],
          [ethers.ZeroHash, ethers.ZeroHash],
          ["0x555344", "0x555344"],
        ),
    )
      .to.be.revertedWithCustomError(noblepay, "FeeNotLessThanAmount")
      .withArgs(100, 100);
  });

  it("settles with the immutable initiation-time fee after governance changes fees", async function () {
    const {
      admin,
      treasury,
      teeNode,
      sender,
      recipient,
      noblepay,
      registry,
      gate,
      token,
    } = await loadFixture(deployMocksFixture);
    await registry.setBusiness(sender.address, true, 0);
    await noblepay.connect(admin).configureTrust(registry.target, gate.target);
    await noblepay.connect(admin).setFees(ethers.parseUnits("1", 6), 100);

    const amount = ethers.parseUnits("100", 6);
    const expectedFee = ethers.parseUnits("2", 6);
    const id = await paymentId(
      await noblepay
        .connect(sender)
        .initiatePayment(
          recipient.address,
          amount,
          token.target,
          ethers.ZeroHash,
          "0x555344",
        ),
    );
    expect(await noblepay.paymentFees(id)).to.equal(expectedFee);

    await noblepay.connect(admin).setFees(0, 0);
    await noblepay
      .connect(teeNode)
      .submitComplianceResult(id, true, 10, true, ethers.ZeroHash, "0x1234");
    await gate.setCleared(sender.address, recipient.address, true);
    await noblepay.settlePayment(id);

    expect(await token.balanceOf(treasury.address)).to.equal(expectedFee);
    expect(await token.balanceOf(recipient.address)).to.equal(
      amount - expectedFee,
    );
  });
});
