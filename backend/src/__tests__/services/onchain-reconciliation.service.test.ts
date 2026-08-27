import crypto from "crypto";
import { Interface, Wallet, parseUnits } from "ethers";
import { Prisma } from "@prisma/client";
import { BusinessRegistrationService } from "../../services/business-registration";
import { PaymentReconciliationService } from "../../services/payment-reconciliation";
import {
  buildRegistrationCommitment,
  buildWalletChallengeMessage,
} from "../../lib/wallet-challenge";

const REGISTRY_ADDRESS = "0x1000000000000000000000000000000000000001";
const NOBLEPAY_ADDRESS = "0x2000000000000000000000000000000000000002";
const RECIPIENT = "0x3000000000000000000000000000000000000003";
const OFFICER = "0x4000000000000000000000000000000000000004";
const USDC = "0x5000000000000000000000000000000000000005";
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;

const registryInterface = new Interface([
  "function registerBusiness(string _licenseNumber,string _businessName,uint8 _jurisdiction,address _complianceOfficer)",
  "function getBusinessDetails(address _business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "event BusinessRegistered(address indexed wallet,string licenseNumber,string businessName,uint8 jurisdiction)",
]);
const paymentInterface = new Interface([
  "function initiatePayment(address _recipient,uint256 _amount,address _token,bytes32 _purposeHash,bytes3 _currencyCode) payable returns (bytes32 paymentId)",
  "function initiatePaymentBatch(address[] _recipients,uint256[] _amounts,address[] _tokens,bytes32[] _purposeHashes,bytes3[] _currencyCodes) payable returns (bytes32 batchId)",
  "function batches(bytes32 _batchId) view returns (bytes32 batchId,address initiator,uint256 totalAmount,uint256 createdAt,bool processed)",
  "function getBatchPaymentIds(bytes32 _batchId) view returns (bytes32[] paymentIds)",
  "function getPayment(bytes32 _paymentId) view returns ((address sender,address recipient,uint256 amount,address token,bytes32 purposeHash,uint8 status,bytes teeAttestation,uint256 createdAt,uint256 settledAt,bytes3 currencyCode))",
  "event PaymentInitiated(bytes32 indexed paymentId,address indexed sender,address indexed recipient,uint256 amount,address token,bytes3 currencyCode)",
  "event BatchProcessed(bytes32 indexed batchId,uint256 paymentCount,uint256 totalAmount)",
]);

function configuredEnvironment(): void {
  process.env.AETHELRED_RPC_URL = "http://127.0.0.1:8545";
  process.env.NOBLEPAY_CHAIN_ID = "2525";
  process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
  process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"ab".repeat(32)}`;
  process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
  process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY_ADDRESS;
  process.env.NOBLEPAY_CONTRACT_ADDRESS = NOBLEPAY_ADDRESS;
  process.env.PUBLIC_ORIGIN = "https://pay.aethelred.network";
  process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
    [USDC]: { currency: "USDC", currencyCode: "USD", decimals: 6 },
  });
}

describe("verified on-chain reconciliation", () => {
  beforeEach(configuredEnvironment);

  it("finalizes a signed BusinessRegistry receipt and stores only the API-key hash", async () => {
    const wallet = Wallet.createRandom();
    const challengeId = "11111111-1111-4111-8111-111111111111";
    const registrationCommitment = buildRegistrationCommitment({
      address: wallet.address,
      txHash: TX_HASH,
      licenseNumber: "DMCC123456",
      businessName: "Acme Treasury",
      jurisdiction: "UAE",
      businessType: "LLC",
      complianceOfficer: OFFICER,
      contactEmail: "ops@example.com",
    });
    const message = buildWalletChallengeMessage({
      address: wallet.address,
      purpose: "registration",
      nonce: "0123456789abcdef0123456789abcdef",
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      challengeId,
      txHash: TX_HASH,
      registrationCommitment,
    });
    const signature = await wallet.signMessage(message);
    const callData = registryInterface.encodeFunctionData("registerBusiness", [
      "DMCC123456",
      "Acme Treasury",
      0,
      OFFICER,
    ]);
    const encodedEvent = registryInterface.encodeEventLog(
      registryInterface.getEvent("BusinessRegistered")!,
      [wallet.address, "DMCC123456", "Acme Treasury", 0],
    );
    const business = {
      id: "biz-1",
      address: wallet.address,
      licenseNumber: "DMCC123456",
      businessName: "Acme Treasury",
      jurisdiction: "UAE",
      businessType: "LLC",
      kycStatus: "PENDING",
      tier: "STANDARD",
      complianceOfficer: OFFICER,
      contactEmail: "ops@example.com",
      registeredAt: new Date(1_700_000_000_000),
      lastVerified: null,
      dailyLimit: new Prisma.Decimal(50_000),
      monthlyLimit: new Prisma.Decimal(500_000),
      registrationTxHash: TX_HASH,
      registrationBlockNumber: 123n,
    };
    const database: any = {
      $executeRaw: jest.fn(),
      walletChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      business: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(business),
      },
      aPIKey: {
        updateMany: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "key-1" }),
      },
      auditLog: {},
    };
    const prisma: any = {
      walletChallenge: {
        findUnique: jest.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          address: wallet.address,
          message,
          purpose: "REGISTRATION",
          transactionHash: TX_HASH,
          expiresAt: new Date(Date.now() + 60_000),
          usedAt: null,
        }),
      },
      $transaction: jest.fn(async (callback: (transaction: any) => unknown) =>
        callback(database),
      ),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 2525n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        hash: TX_HASH,
        logs: [{ address: REGISTRY_ADDRESS, ...encodedEvent }],
        confirmations: jest.fn().mockResolvedValue(2),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        to: REGISTRY_ADDRESS,
        from: wallet.address,
        data: callData,
        value: 0n,
      }),
      getBlock: jest.fn().mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"ab".repeat(32)}` }
            : {
                number: 123,
                hash: BLOCK_HASH,
                timestamp: 1_700_000_000,
              },
        ),
      ),
      getCode: jest.fn().mockResolvedValue("0x"),
      call: jest
        .fn()
        .mockResolvedValue(
          registryInterface.encodeFunctionResult("getBusinessDetails", [
            [
              wallet.address,
              "DMCC123456",
              "Acme Treasury",
              0,
              0,
              0,
              1_700_000_000,
              0,
              OFFICER,
            ],
          ]),
        ),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const service = new BusinessRegistrationService(prisma, audit, provider);

    const result = await service.register({
      address: wallet.address,
      licenseNumber: "DMCC123456",
      businessName: "Acme Treasury",
      jurisdiction: "UAE",
      businessType: "LLC",
      complianceOfficer: OFFICER,
      contactEmail: "ops@example.com",
      txHash: TX_HASH,
      challengeId,
      signature,
    });

    expect(result.business.id).toBe("biz-1");
    expect(result.apiKey).toMatch(/^npk_[a-f0-9]{64}$/);
    expect(result.replayed).toBe(false);
    const persistedKey = database.aPIKey.create.mock.calls[0][0].data;
    expect(persistedKey.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(persistedKey)).not.toContain(result.apiKey);
    expect(database.walletChallenge.updateMany).toHaveBeenCalled();
  });

  it("persists a verified NoblePay PaymentInitiated event without trusting body claims", async () => {
    const wallet = Wallet.createRandom();
    const purposeHash = `0x${crypto.randomBytes(32).toString("hex")}`;
    const paymentId = `0x${crypto.randomBytes(32).toString("hex")}`;
    const amount = parseUnits("1.5", 6);
    const callData = paymentInterface.encodeFunctionData("initiatePayment", [
      RECIPIENT,
      amount,
      USDC,
      purposeHash,
      "0x555344",
    ]);
    const encodedEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [paymentId, wallet.address, RECIPIENT, amount, USDC, "0x555344"],
    );
    const persistedPayment = {
      id: "payment-db-1",
      paymentId,
      sender: wallet.address,
      recipient: RECIPIENT,
      amount: new Prisma.Decimal("1.5"),
      currency: "USDC",
      purposeHash,
      status: "PENDING",
      riskScore: null,
      teeAttestation: null,
      initiatedAt: new Date(1_700_000_000_000),
      screenedAt: null,
      settledAt: null,
      refundedAt: null,
      blockNumber: 456n,
      txHash: TX_HASH,
      businessId: "biz-1",
      idempotencyKey: `chain:2525:${paymentId}`,
    };
    const database: any = {
      $executeRaw: jest.fn(),
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(persistedPayment),
      },
      auditLog: {},
    };
    const prisma: any = {
      business: {
        findUnique: jest.fn().mockResolvedValue({
          id: "biz-1",
          address: wallet.address,
          kycStatus: "VERIFIED",
        }),
      },
      $transaction: jest.fn(async (callback: (transaction: any) => unknown) =>
        callback(database),
      ),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 2525n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 456,
        blockHash: BLOCK_HASH,
        hash: TX_HASH,
        logs: [{ address: NOBLEPAY_ADDRESS, ...encodedEvent }],
        confirmations: jest.fn().mockResolvedValue(3),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 456,
        blockHash: BLOCK_HASH,
        to: NOBLEPAY_ADDRESS,
        from: wallet.address,
        data: callData,
        value: 0n,
      }),
      getBlock: jest.fn().mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"ab".repeat(32)}` }
            : {
                number: 456,
                hash: BLOCK_HASH,
                timestamp: 1_700_000_000,
              },
        ),
      ),
      call: jest.fn().mockImplementation(({ data }: { data: string }) => {
        const parsed = paymentInterface.parseTransaction({ data });
        if (parsed?.name !== "getPayment")
          throw new Error("Unexpected NoblePay state call");
        return paymentInterface.encodeFunctionResult("getPayment", [
          [
            wallet.address,
            RECIPIENT,
            amount,
            USDC,
            purposeHash,
            0,
            "0x",
            1_700_000_000,
            0,
            "0x555344",
          ],
        ]);
      }),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const service = new PaymentReconciliationService(prisma, audit, provider);

    const result = await service.reconcile(
      {
        txHash: TX_HASH,
        recipient: RECIPIENT,
        amount: "1.5",
        currency: "USDC",
        purposeHash,
      },
      "biz-1",
    );

    expect(result.payment.paymentId).toBe(paymentId);
    expect(result.payment.status).toBe("PENDING");
    expect(result.payment.txHash).toBe(TX_HASH);
    expect(database.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockNumber: 456n,
          businessId: "biz-1",
        }),
      }),
    );
  });

  it("reconciles an explicitly selected payment from a verified atomic batch", async () => {
    const wallet = Wallet.createRandom();
    const firstPurpose = `0x${crypto.randomBytes(32).toString("hex")}`;
    const secondPurpose = `0x${crypto.randomBytes(32).toString("hex")}`;
    const firstPaymentId = `0x${crypto.randomBytes(32).toString("hex")}`;
    const secondPaymentId = `0x${crypto.randomBytes(32).toString("hex")}`;
    const batchId = `0x${crypto.randomBytes(32).toString("hex")}`;
    const firstAmount = parseUnits("1.5", 6);
    const secondAmount = parseUnits("2", 6);
    const callData = paymentInterface.encodeFunctionData(
      "initiatePaymentBatch",
      [
        [RECIPIENT, OFFICER],
        [firstAmount, secondAmount],
        [USDC, USDC],
        [firstPurpose, secondPurpose],
        ["0x555344", "0x555344"],
      ],
    );
    const firstEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [
        firstPaymentId,
        wallet.address,
        RECIPIENT,
        firstAmount,
        USDC,
        "0x555344",
      ],
    );
    const secondEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [
        secondPaymentId,
        wallet.address,
        OFFICER,
        secondAmount,
        USDC,
        "0x555344",
      ],
    );
    const batchEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("BatchProcessed")!,
      [batchId, 2n, firstAmount + secondAmount],
    );
    const persistedPayment = {
      id: "payment-db-batch-2",
      paymentId: secondPaymentId,
      sender: wallet.address,
      recipient: OFFICER,
      amount: new Prisma.Decimal("2"),
      currency: "USDC",
      purposeHash: secondPurpose,
      status: "PENDING",
      riskScore: null,
      teeAttestation: null,
      initiatedAt: new Date(1_700_000_000_000),
      screenedAt: null,
      settledAt: null,
      refundedAt: null,
      blockNumber: 456n,
      txHash: TX_HASH,
      businessId: "biz-1",
      idempotencyKey: `chain:2525:${secondPaymentId}`,
    };
    const database: any = {
      $executeRaw: jest.fn(),
      payment: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(persistedPayment),
      },
      auditLog: {},
    };
    const prisma: any = {
      business: {
        findUnique: jest.fn().mockResolvedValue({
          id: "biz-1",
          address: wallet.address,
          kycStatus: "VERIFIED",
        }),
      },
      $transaction: jest.fn(async (callback: (transaction: any) => unknown) =>
        callback(database),
      ),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 2525n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        status: 1,
        blockNumber: 456,
        blockHash: BLOCK_HASH,
        hash: TX_HASH,
        logs: [
          { address: NOBLEPAY_ADDRESS, ...firstEvent },
          { address: NOBLEPAY_ADDRESS, ...secondEvent },
          { address: NOBLEPAY_ADDRESS, ...batchEvent },
        ],
        confirmations: jest.fn().mockResolvedValue(3),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 456,
        blockHash: BLOCK_HASH,
        to: NOBLEPAY_ADDRESS,
        from: wallet.address,
        data: callData,
        value: 0n,
      }),
      getBlock: jest.fn().mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"ab".repeat(32)}` }
            : {
                number: 456,
                hash: BLOCK_HASH,
                timestamp: 1_700_000_000,
              },
        ),
      ),
      call: jest.fn().mockImplementation(({ data }: { data: string }) => {
        const parsed = paymentInterface.parseTransaction({ data });
        if (parsed?.name === "batches") {
          return paymentInterface.encodeFunctionResult("batches", [
            batchId,
            wallet.address,
            firstAmount + secondAmount,
            1_700_000_000,
            true,
          ]);
        }
        if (parsed?.name === "getBatchPaymentIds") {
          return paymentInterface.encodeFunctionResult("getBatchPaymentIds", [
            [firstPaymentId, secondPaymentId],
          ]);
        }
        if (parsed?.name === "getPayment") {
          return paymentInterface.encodeFunctionResult("getPayment", [
            [
              wallet.address,
              OFFICER,
              secondAmount,
              USDC,
              secondPurpose,
              0,
              "0x",
              1_700_000_000,
              0,
              "0x555344",
            ],
          ]);
        }
        throw new Error("Unexpected NoblePay state call");
      }),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const service = new PaymentReconciliationService(prisma, audit, provider);

    const result = await service.reconcile(
      {
        txHash: TX_HASH,
        paymentId: secondPaymentId,
        recipient: OFFICER,
        amount: "2",
        currency: "USDC",
        purposeHash: secondPurpose,
      },
      "biz-1",
    );

    expect(result.payment.paymentId).toBe(secondPaymentId);
    expect(database.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paymentId: secondPaymentId,
          recipient: OFFICER,
          purposeHash: secondPurpose,
        }),
      }),
    );
    expect(provider.call).toHaveBeenCalledTimes(3);
  });
});
