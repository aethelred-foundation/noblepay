import { Prisma } from "@prisma/client";
import { Interface } from "ethers";
import {
  PaymentLifecycleAction,
  PaymentReconciliationService,
} from "../../services/payment-reconciliation";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const OTHER_TOKEN = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x5555555555555555555555555555555555555555";
const OTHER_RECIPIENT = "0x6666666666666666666666666666666666666666";
const SENDER = "0x7777777777777777777777777777777777777777";
const OTHER_SENDER = "0x8888888888888888888888888888888888888888";
const PAYMENT_ID = `0x${"ab".repeat(32)}`;
const OTHER_PAYMENT_ID = `0x${"ef".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const OTHER_TX_HASH = `0x${"01".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const PURPOSE_HASH = `0x${"12".repeat(32)}`;
const OTHER_PURPOSE_HASH = `0x${"34".repeat(32)}`;
const BATCH_ID = `0x${"56".repeat(32)}`;
const TIMESTAMP = 1_750_000_000;

const paymentInterface = new Interface([
  "function initiatePayment(address _recipient,uint256 _amount,address _token,bytes32 _purposeHash,bytes3 _currencyCode) payable returns (bytes32 paymentId)",
  "function initiatePaymentBatch(address[] _recipients,uint256[] _amounts,address[] _tokens,bytes32[] _purposeHashes,bytes3[] _currencyCodes) payable returns (bytes32 batchId)",
  "function settlePayment(bytes32 _paymentId)",
  "function cancelPayment(bytes32 _paymentId)",
  "function refundPayment(bytes32 _paymentId)",
  "function executeSettlementRecovery(bytes32 _paymentId)",
  "function getPayment(bytes32 _paymentId) view returns ((address sender,address recipient,uint256 amount,address token,bytes32 purposeHash,uint8 status,bytes teeAttestation,uint256 createdAt,uint256 settledAt,bytes3 currencyCode))",
  "function batches(bytes32 _batchId) view returns (bytes32 batchId,address initiator,uint256 totalAmount,uint256 createdAt,bool processed)",
  "function getBatchPaymentIds(bytes32 _batchId) view returns (bytes32[] paymentIds)",
  "event PaymentInitiated(bytes32 indexed paymentId,address indexed sender,address indexed recipient,uint256 amount,address token,bytes3 currencyCode)",
  "event BatchProcessed(bytes32 indexed batchId,uint256 paymentCount,uint256 totalAmount)",
  "event PaymentSettled(bytes32 indexed paymentId,uint256 settledAt,uint256 feeCollected)",
  "event PaymentRefunded(bytes32 indexed paymentId,uint256 refundedAt)",
  "event SettlementRecoveryExecuted(bytes32 indexed paymentId,address indexed executedBy,uint256 refundedAt)",
]);

const safeInterface = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);

function safeExecution(innerData: string, operation = 0, target = CONTRACT) {
  return safeInterface.encodeFunctionData("execTransaction", [
    target,
    0n,
    innerData,
    operation,
    0n,
    0n,
    0n,
    "0x0000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
    "0x1234",
  ]);
}

function configureEnvironment(): void {
  process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
  process.env.NOBLEPAY_CHAIN_ID = "7332";
  process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
  process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"99".repeat(32)}`;
  process.env.NOBLEPAY_CONTRACT_ADDRESS = CONTRACT;
  process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY;
  process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
  process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
    [TOKEN]: { currency: "USDC", currencyCode: "USD", decimals: 6 },
  });
}

function persistedPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    paymentId: PAYMENT_ID,
    sender: SENDER,
    recipient: RECIPIENT,
    amount: new Prisma.Decimal("1.5"),
    currency: "USDC",
    purposeHash: PURPOSE_HASH,
    status: "PENDING",
    riskScore: null,
    teeAttestation: null,
    initiatedAt: new Date(TIMESTAMP * 1000),
    screenedAt: null,
    settledAt: null,
    refundedAt: null,
    blockNumber: 456n,
    txHash: TX_HASH,
    businessId: "biz-1",
    idempotencyKey: `chain:7332:${PAYMENT_ID}`,
    ...overrides,
  } as any;
}

function initiationFixture() {
  const callData = paymentInterface.encodeFunctionData("initiatePayment", [
    RECIPIENT,
    1_500_000n,
    TOKEN,
    PURPOSE_HASH,
    "0x555344",
  ]);
  const event = paymentInterface.encodeEventLog(
    paymentInterface.getEvent("PaymentInitiated")!,
    [PAYMENT_ID, SENDER, RECIPIENT, 1_500_000n, TOKEN, "0x555344"],
  );
  const stored = persistedPayment();
  const transactionDb: any = {
    $executeRaw: jest.fn(),
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(stored),
    },
  };
  const prisma: any = {
    business: {
      findUnique: jest.fn().mockResolvedValue({
        id: "biz-1",
        address: SENDER,
        kycStatus: "VERIFIED",
      }),
    },
    $transaction: jest.fn(async (callback: (database: any) => unknown) =>
      callback(transactionDb),
    ),
  };
  const receipt: any = {
    status: 1,
    blockNumber: 456,
    blockHash: BLOCK_HASH,
    hash: TX_HASH,
    logs: [{ address: CONTRACT, ...event }],
    confirmations: jest.fn().mockResolvedValue(3),
  };
  const transaction: any = {
    hash: TX_HASH,
    blockNumber: 456,
    blockHash: BLOCK_HASH,
    to: CONTRACT,
    from: SENDER,
    data: callData,
    value: 0n,
  };
  const provider: any = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue(transaction),
    getBlock: jest
      .fn()
      .mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"99".repeat(32)}` }
            : { number: 456, hash: BLOCK_HASH, timestamp: TIMESTAMP },
        ),
      ),
    call: jest
      .fn()
      .mockResolvedValue(
        paymentInterface.encodeFunctionResult("getPayment", [
          [
            SENDER,
            RECIPIENT,
            1_500_000n,
            TOKEN,
            PURPOSE_HASH,
            0,
            "0x",
            TIMESTAMP,
            0,
            "0x555344",
          ],
        ]),
      ),
  };
  const audit: any = {
    createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
  };
  const input = {
    txHash: TX_HASH,
    recipient: RECIPIENT,
    amount: "1.5",
    currency: "USDC",
    purposeHash: PURPOSE_HASH,
  };
  return {
    service: new PaymentReconciliationService(prisma, audit, provider),
    prisma,
    transactionDb,
    provider,
    receipt,
    transaction,
    audit,
    input,
    stored,
  };
}

function lifecycleFixture(action: PaymentLifecycleAction = "settle") {
  const payment = persistedPayment({
    initiatedAt: new Date((TIMESTAMP - 100) * 1000),
  });
  const event =
    action === "settle"
      ? paymentInterface.encodeEventLog(
          paymentInterface.getEvent("PaymentSettled")!,
          [PAYMENT_ID, TIMESTAMP, 10n],
        )
      : paymentInterface.encodeEventLog(
          paymentInterface.getEvent("PaymentRefunded")!,
          [PAYMENT_ID, TIMESTAMP],
        );
  const method =
    action === "settle"
      ? "settlePayment"
      : action === "cancel"
        ? "cancelPayment"
        : "refundPayment";
  const status =
    action === "settle"
      ? "SETTLED"
      : action === "cancel"
        ? "CANCELLED"
        : "REFUNDED";
  const transactionDb: any = {
    $executeRaw: jest.fn(),
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    payment: {
      findFirst: jest.fn().mockResolvedValue(payment),
      update: jest.fn().mockResolvedValue(persistedPayment({ status })),
    },
  };
  const prisma: any = {
    payment: { findFirst: jest.fn().mockResolvedValue(payment) },
    $transaction: jest.fn(async (callback: (database: any) => unknown) =>
      callback(transactionDb),
    ),
  };
  const receipt: any = {
    hash: TX_HASH,
    status: 1,
    blockNumber: 77,
    blockHash: BLOCK_HASH,
    logs: [{ address: CONTRACT, ...event }],
    confirmations: jest.fn().mockResolvedValue(3),
  };
  const transaction: any = {
    hash: TX_HASH,
    blockNumber: 77,
    blockHash: BLOCK_HASH,
    to: CONTRACT,
    from: SENDER,
    data: paymentInterface.encodeFunctionData(method, [PAYMENT_ID]),
    value: 0n,
  };
  const provider: any = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue(transaction),
    getBlock: jest
      .fn()
      .mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"99".repeat(32)}` }
            : { number: 77, hash: BLOCK_HASH, timestamp: TIMESTAMP },
        ),
      ),
    call: jest
      .fn()
      .mockResolvedValue(
        paymentInterface.encodeFunctionResult("getPayment", [
          [
            SENDER,
            RECIPIENT,
            1_500_000n,
            TOKEN,
            PURPOSE_HASH,
            action === "settle" ? 4 : 5,
            "0x",
            TIMESTAMP - 100,
            action === "settle" ? TIMESTAMP : 0,
            "0x555344",
          ],
        ]),
      ),
  };
  const audit: any = {
    createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
  };
  return {
    service: new PaymentReconciliationService(prisma, audit, provider),
    prisma,
    transactionDb,
    provider,
    receipt,
    transaction,
    audit,
    payment,
    action,
  };
}

describe("PaymentReconciliationService initiation branch behavior", () => {
  const priorEnv: NodeJS.ProcessEnv = {};

  beforeAll(() => {
    for (const key of [
      "AETHELRED_RPC_URL",
      "NOBLEPAY_CHAIN_ID",
      "AETHELRED_NETWORK_ANCHOR_BLOCK",
      "AETHELRED_NETWORK_ANCHOR_HASH",
      "NOBLEPAY_CONTRACT_ADDRESS",
      "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
      "NOBLEPAY_MIN_CONFIRMATIONS",
      "NOBLEPAY_TOKEN_CONFIG",
    ])
      priorEnv[key] = process.env[key];
  });

  beforeEach(configureEnvironment);

  afterAll(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports invalid chain configuration as a stable reconciliation error", async () => {
    delete process.env.AETHELRED_RPC_URL;
    const fixture = initiationFixture();
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({
      code: "RECONCILIATION_MISCONFIGURED",
      statusCode: 503,
    });
    expect(fixture.provider.getNetwork).not.toHaveBeenCalled();
  });

  it("maps an RPC transport error without exposing its details", async () => {
    const fixture = initiationFixture();
    fixture.provider.getNetwork.mockRejectedValue(
      new Error("secret RPC detail"),
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({
      code: "CHAIN_RPC_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("rejects a provider connected to a different chain", async () => {
    const fixture = initiationFixture();
    fixture.provider.getNetwork.mockResolvedValue({ chainId: 1n });
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("rejects a same-chain-id provider with a different immutable anchor", async () => {
    const fixture = initiationFixture();
    fixture.provider.getBlock.mockImplementation((blockTag: string | bigint) =>
      Promise.resolve(
        blockTag === 1n
          ? { number: 1, hash: `0x${"cd".repeat(32)}` }
          : { timestamp: TIMESTAMP },
      ),
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "CHAIN_MISMATCH", statusCode: 503 });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not persist an initiation whose receipt is not in the canonical block", async () => {
    const fixture = initiationFixture();
    fixture.provider.getBlock.mockImplementation((blockTag: string | bigint) =>
      Promise.resolve(
        blockTag === 1n
          ? { number: 1, hash: `0x${"99".repeat(32)}` }
          : {
              number: 456,
              hash: `0x${"de".repeat(32)}`,
              timestamp: TIMESTAMP,
            },
      ),
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "TRANSACTION_CANONICAL_MISMATCH" });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.transactionDb.payment.create).not.toHaveBeenCalled();
  });

  it.each(["receipt", "transaction"] as const)(
    "requires a mined %s",
    async (missing) => {
      const fixture = initiationFixture();
      if (missing === "receipt")
        fixture.provider.getTransactionReceipt.mockResolvedValue(null);
      else fixture.provider.getTransaction.mockResolvedValue(null);
      await expect(
        fixture.service.reconcile(fixture.input, "biz-1"),
      ).rejects.toMatchObject({ code: "TRANSACTION_NOT_MINED" });
    },
  );

  it.each(["receipt", "transaction"] as const)(
    "rejects a mismatched %s hash",
    async (target) => {
      const fixture = initiationFixture();
      fixture[target].hash = OTHER_TX_HASH;
      await expect(
        fixture.service.reconcile(fixture.input, "biz-1"),
      ).rejects.toMatchObject({ code: "TRANSACTION_HASH_MISMATCH" });
    },
  );

  it("rejects a reverted transaction", async () => {
    const fixture = initiationFixture();
    fixture.receipt.status = 0;
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "TRANSACTION_REVERTED" });
  });

  it.each([null, OTHER_RECIPIENT])(
    "rejects the wrong payment contract %s",
    async (to) => {
      const fixture = initiationFixture();
      fixture.transaction.to = to;
      await expect(
        fixture.service.reconcile(fixture.input, "biz-1"),
      ).rejects.toMatchObject({ code: "INVALID_PAYMENT_EXECUTION" });
    },
  );

  it("rejects native value attached to a stablecoin call", async () => {
    const fixture = initiationFixture();
    fixture.transaction.value = 1n;
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_EXECUTION" });
  });

  it.each([
    ["0x1234", "malformed"],
    [
      paymentInterface.encodeFunctionData("settlePayment", [PAYMENT_ID]),
      "other method",
    ],
  ])("requires initiatePayment calldata (%s)", async (data, _label) => {
    const fixture = initiationFixture();
    fixture.transaction.data = data;
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_CALL" });
  });

  it.each([
    [null, "BUSINESS_NOT_FOUND"],
    [{ id: "biz-1", address: SENDER, kycStatus: "PENDING" }, "KYC_REQUIRED"],
    [
      { id: "biz-1", address: OTHER_SENDER, kycStatus: "VERIFIED" },
      "INVALID_PAYMENT_EXECUTION",
    ],
  ])("rejects an ineligible tenant wallet %#", async (business, code) => {
    const fixture = initiationFixture();
    fixture.prisma.business.findUnique.mockResolvedValue(business);
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code });
  });

  it("requires the configured confirmation depth", async () => {
    const fixture = initiationFixture();
    fixture.receipt.confirmations.mockResolvedValue(1);
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CONFIRMATIONS" });
  });

  it("does not persist when final confirmation depth falls below policy", async () => {
    const fixture = initiationFixture();
    fixture.receipt.confirmations
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);

    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_CONFIRMATIONS",
      statusCode: 409,
    });

    expect(fixture.receipt.confirmations).toHaveBeenCalledTimes(3);
    expect(fixture.provider.call).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.transactionDb.payment.create).not.toHaveBeenCalled();
  });

  it("ignores unrelated and malformed logs but requires one payment event", async () => {
    const fixture = initiationFixture();
    fixture.receipt.logs = [
      { address: OTHER_RECIPIENT, topics: [], data: "0x" },
      { address: CONTRACT, topics: ["0xinvalid"], data: "0x" },
      {
        address: CONTRACT,
        ...paymentInterface.encodeEventLog(
          paymentInterface.getEvent("PaymentSettled")!,
          [PAYMENT_ID, TIMESTAMP, 0n],
        ),
      },
    ];
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "PAYMENT_EVENT_NOT_FOUND" });
  });

  it("rejects multiple PaymentInitiated events", async () => {
    const fixture = initiationFixture();
    fixture.receipt.logs.push(fixture.receipt.logs[0]);
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_PAYMENT_EVENT" });
  });

  it("rejects an event emitted for another sender", async () => {
    const fixture = initiationFixture();
    const event = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [PAYMENT_ID, OTHER_SENDER, RECIPIENT, 1_500_000n, TOKEN, "0x555344"],
    );
    fixture.receipt.logs = [{ address: CONTRACT, ...event }];
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "PAYMENT_SENDER_MISMATCH" });
  });

  it.each([
    [OTHER_TOKEN, "0x555344", "token"],
    [TOKEN, "0x455552", "currency"],
  ])("rejects an unsupported event %s", async (token, currencyCode, _label) => {
    const fixture = initiationFixture();
    const event = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [PAYMENT_ID, SENDER, RECIPIENT, 1_500_000n, token, currencyCode],
    );
    fixture.receipt.logs = [{ address: CONTRACT, ...event }];
    fixture.transaction.data = paymentInterface.encodeFunctionData(
      "initiatePayment",
      [RECIPIENT, 1_500_000n, token, PURPOSE_HASH, currencyCode],
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TOKEN_EVENT" });
  });

  it("rejects a zero payment event", async () => {
    const fixture = initiationFixture();
    const event = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [PAYMENT_ID, SENDER, RECIPIENT, 0n, TOKEN, "0x555344"],
    );
    fixture.receipt.logs = [{ address: CONTRACT, ...event }];
    fixture.transaction.data = paymentInterface.encodeFunctionData(
      "initiatePayment",
      [RECIPIENT, 0n, TOKEN, PURPOSE_HASH, "0x555344"],
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_EVENT" });
  });

  it("rejects a malformed emitted currency code", async () => {
    const fixture = initiationFixture();
    const event = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("PaymentInitiated")!,
      [PAYMENT_ID, SENDER, RECIPIENT, 1_500_000n, TOKEN, "0x555300"],
    );
    fixture.receipt.logs = [{ address: CONTRACT, ...event }];
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "PAYMENT_EVENT_NOT_FOUND" });
  });

  it.each([
    [OTHER_RECIPIENT, 1_500_000n, TOKEN, "0x555344", "recipient"],
    [RECIPIENT, 1_400_000n, TOKEN, "0x555344", "amount"],
    [RECIPIENT, 1_500_000n, OTHER_TOKEN, "0x555344", "token"],
    [RECIPIENT, 1_500_000n, TOKEN, "0x455552", "currency"],
  ])(
    "requires call and event %s to match",
    async (recipient, amount, token, currencyCode, _label) => {
      const fixture = initiationFixture();
      fixture.transaction.data = paymentInterface.encodeFunctionData(
        "initiatePayment",
        [recipient, amount, token, PURPOSE_HASH, currencyCode],
      );
      await expect(
        fixture.service.reconcile(fixture.input, "biz-1"),
      ).rejects.toMatchObject({ code: "PAYMENT_EVENT_MISMATCH" });
    },
  );

  it("requires the transaction block", async () => {
    const fixture = initiationFixture();
    fixture.provider.getBlock.mockImplementation((blockTag: string | bigint) =>
      Promise.resolve(
        blockTag === 1n ? { number: 1, hash: `0x${"99".repeat(32)}` } : null,
      ),
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({ code: "BLOCK_NOT_FOUND" });
  });

  it.each([
    [{ recipient: OTHER_RECIPIENT }, "recipient"],
    [{ amount: "1.4" }, "amount"],
    [{ currency: "EUR" }, "currency"],
    [{ purposeHash: OTHER_PURPOSE_HASH }, "purpose"],
  ])("rejects a mismatched API %s claim", async (override, _label) => {
    const fixture = initiationFixture();
    await expect(
      fixture.service.reconcile({ ...fixture.input, ...override }, "biz-1"),
    ).rejects.toMatchObject({ code: "PAYMENT_CLAIM_MISMATCH" });
  });

  it("returns an exact persisted replay without creating metrics twice", async () => {
    const fixture = initiationFixture();
    fixture.transactionDb.payment.findUnique.mockResolvedValue(fixture.stored);
    const result = await fixture.service.reconcile(fixture.input, "biz-1");
    expect(result).toMatchObject({
      replayed: true,
      confirmations: 3,
      chainId: "7332",
    });
    expect(fixture.transactionDb.payment.create).not.toHaveBeenCalled();
  });

  it("reconciles a single payment executed by the registered Safe", async () => {
    const fixture = initiationFixture();
    const innerData = fixture.transaction.data;
    fixture.transaction.to = SENDER;
    fixture.transaction.from = OTHER_SENDER;
    fixture.transaction.data = safeExecution(innerData);
    fixture.provider.getCode = jest.fn().mockResolvedValue("0x6001600055");

    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).resolves.toMatchObject({ replayed: false, chainId: "7332" });
    expect(fixture.provider.getCode).toHaveBeenCalledWith(SENDER, 456);
  });

  it("reconciles a batch payment executed by the registered Safe", async () => {
    const fixture = initiationFixture();
    (fixture.input as typeof fixture.input & { paymentId: string }).paymentId =
      PAYMENT_ID;
    const innerData = paymentInterface.encodeFunctionData(
      "initiatePaymentBatch",
      [[RECIPIENT], [1_500_000n], [TOKEN], [PURPOSE_HASH], ["0x555344"]],
    );
    fixture.transaction.to = SENDER;
    fixture.transaction.from = OTHER_SENDER;
    fixture.transaction.data = safeExecution(innerData);
    fixture.provider.getCode = jest.fn().mockResolvedValue("0x6001600055");
    const batchEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("BatchProcessed")!,
      [BATCH_ID, 1n, 1_500_000n],
    );
    fixture.receipt.logs.push({ address: CONTRACT, ...batchEvent });
    const originalCall = fixture.provider.call;
    fixture.provider.call = jest.fn(async ({ data }: { data: string }) => {
      if (data.startsWith(paymentInterface.getFunction("batches")!.selector)) {
        return paymentInterface.encodeFunctionResult("batches", [
          BATCH_ID,
          SENDER,
          1_500_000n,
          TIMESTAMP,
          true,
        ]);
      }
      if (
        data.startsWith(
          paymentInterface.getFunction("getBatchPaymentIds")!.selector,
        )
      ) {
        return paymentInterface.encodeFunctionResult("getBatchPaymentIds", [
          [PAYMENT_ID],
        ]);
      }
      return originalCall({ data });
    });

    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).resolves.toMatchObject({ replayed: false, chainId: "7332" });
  });

  it.each([
    [{ businessId: "biz-2" }, "business"],
    [{ txHash: OTHER_TX_HASH }, "transaction"],
    [{ sender: OTHER_SENDER }, "sender"],
    [{ recipient: OTHER_RECIPIENT }, "recipient"],
    [{ amount: new Prisma.Decimal("1.4") }, "amount"],
    [{ currency: "EUR" }, "currency"],
    [{ purposeHash: OTHER_PURPOSE_HASH }, "purpose"],
  ])("rejects a persisted replay conflict on %s", async (override, _label) => {
    const fixture = initiationFixture();
    fixture.transactionDb.payment.findUnique.mockResolvedValue(
      persistedPayment(override),
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toMatchObject({
      code: "PAYMENT_RECONCILIATION_CONFLICT",
    });
  });

  it("retries serializable conflicts and succeeds", async () => {
    const fixture = initiationFixture();
    const conflict = new Prisma.PrismaClientKnownRequestError(
      "serialization conflict",
      {
        code: "P2034",
        clientVersion: "5.8.1",
      },
    );
    fixture.prisma.$transaction.mockRejectedValueOnce(conflict);
    const result = await fixture.service.reconcile(fixture.input, "biz-1");
    expect(result.replayed).toBe(false);
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-serializable failures", async () => {
    const fixture = initiationFixture();
    fixture.prisma.$transaction.mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      fixture.service.reconcile(fixture.input, "biz-1"),
    ).rejects.toThrow("database unavailable");
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentReconciliationService lifecycle branch behavior", () => {
  beforeEach(configureEnvironment);

  it.each(["settle", "cancel", "refund"] as const)(
    "persists a verified %s transition",
    async (action) => {
      const fixture = lifecycleFixture(action);
      const result = await fixture.service.reconcileLifecycle(
        fixture.payment.id,
        action,
        TX_HASH,
        "biz-1",
      );
      expect(result).toMatchObject({
        action,
        replayed: false,
        txHash: TX_HASH,
        confirmations: 3,
        chainId: "7332",
      });
      expect(fixture.transactionDb.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status:
              action === "settle"
                ? "SETTLED"
                : action === "cancel"
                  ? "CANCELLED"
                  : "REFUNDED",
          }),
        }),
      );
      expect(fixture.audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
        fixture.transactionDb,
        expect.objectContaining({
          eventType:
            action === "settle"
              ? "PAYMENT_SETTLED"
              : action === "cancel"
                ? "PAYMENT_CANCELLED"
                : "PAYMENT_REFUNDED",
        }),
      );
    },
  );

  it("accepts a proved delayed settlement recovery as the refund transition", async () => {
    const fixture = lifecycleFixture("refund");
    fixture.transaction.data = paymentInterface.encodeFunctionData(
      "executeSettlementRecovery",
      [PAYMENT_ID],
    );
    const recoveryEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("SettlementRecoveryExecuted")!,
      [PAYMENT_ID, SENDER, TIMESTAMP],
    );
    fixture.receipt.logs.unshift({ address: CONTRACT, ...recoveryEvent });

    const result = await fixture.service.reconcileLifecycle(
      fixture.payment.id,
      "refund",
      TX_HASH,
      "biz-1",
    );

    expect(result).toMatchObject({
      action: "refund",
      method: "executeSettlementRecovery",
      replayed: false,
    });
    expect(fixture.audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      fixture.transactionDb,
      expect.objectContaining({
        eventType: "PAYMENT_REFUNDED",
        description: expect.stringContaining("executeSettlementRecovery"),
        metadata: expect.objectContaining({
          action: "refund",
          method: "executeSettlementRecovery",
        }),
      }),
    );
  });

  it("rejects recovery calldata without its exact execution proof event", async () => {
    const fixture = lifecycleFixture("refund");
    fixture.transaction.data = paymentInterface.encodeFunctionData(
      "executeSettlementRecovery",
      [PAYMENT_ID],
    );

    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "refund",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_EVENT_MISMATCH" });
  });

  it("rejects a recovery event attributed to a different executor", async () => {
    const fixture = lifecycleFixture("refund");
    fixture.transaction.data = paymentInterface.encodeFunctionData(
      "executeSettlementRecovery",
      [PAYMENT_ID],
    );
    const recoveryEvent = paymentInterface.encodeEventLog(
      paymentInterface.getEvent("SettlementRecoveryExecuted")!,
      [PAYMENT_ID, OTHER_SENDER, TIMESTAMP],
    );
    fixture.receipt.logs.unshift({ address: CONTRACT, ...recoveryEvent });

    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "refund",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_EVENT_MISMATCH" });
  });

  it("looks up a chain payment ID as well as an internal ID", async () => {
    const fixture = lifecycleFixture("settle");
    await fixture.service.reconcileLifecycle(
      PAYMENT_ID,
      "settle",
      TX_HASH,
      "biz-1",
    );
    expect(fixture.prisma.payment.findFirst).toHaveBeenCalledWith({
      where: { businessId: "biz-1", paymentId: PAYMENT_ID },
    });
  });

  it("conceals a missing tenant payment", async () => {
    const fixture = lifecycleFixture();
    fixture.prisma.payment.findFirst.mockResolvedValue(null);
    await expect(
      fixture.service.reconcileLifecycle("missing", "settle", TX_HASH, "biz-1"),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
  });

  it("classifies lifecycle RPC failure", async () => {
    const fixture = lifecycleFixture();
    fixture.provider.getNetwork.mockRejectedValue(new Error("rpc down"));
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "CHAIN_RPC_UNAVAILABLE" });
  });

  it("rejects a lifecycle RPC on another chain", async () => {
    const fixture = lifecycleFixture();
    fixture.provider.getNetwork.mockResolvedValue({ chainId: 1n });
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "CHAIN_MISMATCH" });
  });

  it("does not persist a lifecycle transition from an orphaned receipt", async () => {
    const fixture = lifecycleFixture("settle");
    fixture.transaction.blockHash = `0x${"de".repeat(32)}`;
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "TRANSACTION_CANONICAL_MISMATCH" });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.transactionDb.payment.update).not.toHaveBeenCalled();
  });

  it.each(["receipt", "transaction"] as const)(
    "requires a mined lifecycle %s",
    async (missing) => {
      const fixture = lifecycleFixture();
      if (missing === "receipt")
        fixture.provider.getTransactionReceipt.mockResolvedValue(null);
      else fixture.provider.getTransaction.mockResolvedValue(null);
      await expect(
        fixture.service.reconcileLifecycle(
          fixture.payment.id,
          "settle",
          TX_HASH,
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "TRANSACTION_NOT_MINED" });
    },
  );

  it.each(["receipt", "transaction"] as const)(
    "rejects lifecycle %s hash substitution",
    async (target) => {
      const fixture = lifecycleFixture();
      fixture[target].hash = OTHER_TX_HASH;
      await expect(
        fixture.service.reconcileLifecycle(
          fixture.payment.id,
          "settle",
          TX_HASH,
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "TRANSACTION_HASH_MISMATCH" });
    },
  );

  it("rejects a reverted lifecycle transaction", async () => {
    const fixture = lifecycleFixture();
    fixture.receipt.status = 0;
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "TRANSACTION_REVERTED" });
  });

  it.each([null, OTHER_RECIPIENT])(
    "rejects lifecycle sent to contract %s",
    async (to) => {
      const fixture = lifecycleFixture();
      fixture.transaction.to = to;
      await expect(
        fixture.service.reconcileLifecycle(
          fixture.payment.id,
          "settle",
          TX_HASH,
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_EXECUTION" });
    },
  );

  it("rejects native value and insufficient confirmations", async () => {
    const withValue = lifecycleFixture();
    withValue.transaction.value = 1n;
    await expect(
      withValue.service.reconcileLifecycle(
        withValue.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_EXECUTION" });

    const unconfirmed = lifecycleFixture();
    unconfirmed.receipt.confirmations.mockResolvedValue(1);
    await expect(
      unconfirmed.service.reconcileLifecycle(
        unconfirmed.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CONFIRMATIONS" });
  });

  it.each([
    ["0x1234", "malformed"],
    [
      paymentInterface.encodeFunctionData("refundPayment", [PAYMENT_ID]),
      "wrong method",
    ],
  ])("requires exact lifecycle calldata (%s)", async (data, _label) => {
    const fixture = lifecycleFixture("settle");
    fixture.transaction.data = data;
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_CALL" });
  });

  it("rejects lifecycle calldata targeting another payment", async () => {
    const fixture = lifecycleFixture("settle");
    fixture.transaction.data = paymentInterface.encodeFunctionData(
      "settlePayment",
      [OTHER_PAYMENT_ID],
    );
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_CLAIM_MISMATCH" });
  });

  it("requires the tenant sender to sign cancellation", async () => {
    const fixture = lifecycleFixture("cancel");
    fixture.transaction.from = OTHER_SENDER;
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "cancel",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_EXECUTION" });
  });

  it("reconciles cancellation executed by the payment sender Safe", async () => {
    const fixture = lifecycleFixture("cancel");
    const innerData = fixture.transaction.data;
    fixture.transaction.to = SENDER;
    fixture.transaction.from = OTHER_SENDER;
    fixture.transaction.data = safeExecution(innerData);
    fixture.provider.getCode = jest.fn().mockResolvedValue("0x6001600055");

    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "cancel",
        TX_HASH,
        "biz-1",
      ),
    ).resolves.toMatchObject({
      action: "cancel",
      method: "cancelPayment",
      replayed: false,
    });
  });

  it("ignores unrelated lifecycle logs but requires exactly one matching event", async () => {
    const fixture = lifecycleFixture("settle");
    fixture.receipt.logs = [
      { address: OTHER_RECIPIENT, topics: [], data: "0x" },
      { address: CONTRACT, topics: ["0xinvalid"], data: "0x" },
      {
        address: CONTRACT,
        ...paymentInterface.encodeEventLog(
          paymentInterface.getEvent("PaymentRefunded")!,
          [PAYMENT_ID, TIMESTAMP],
        ),
      },
      {
        address: CONTRACT,
        ...paymentInterface.encodeEventLog(
          paymentInterface.getEvent("PaymentSettled")!,
          [OTHER_PAYMENT_ID, TIMESTAMP, 0n],
        ),
      },
    ];
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_EVENT_MISMATCH" });
  });

  it("rejects duplicate matching lifecycle events", async () => {
    const fixture = lifecycleFixture("settle");
    fixture.receipt.logs.push(fixture.receipt.logs[0]);
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_EVENT_MISMATCH" });
  });

  it.each([
    [null, TIMESTAMP, "missing block", "BLOCK_NOT_FOUND"],
    [
      { number: 77, hash: BLOCK_HASH, timestamp: TIMESTAMP },
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      "unsafe timestamp",
      "LIFECYCLE_EVENT_MISMATCH",
    ],
    [
      { number: 77, hash: BLOCK_HASH, timestamp: TIMESTAMP },
      0,
      "zero timestamp",
      "LIFECYCLE_EVENT_MISMATCH",
    ],
    [
      { number: 77, hash: BLOCK_HASH, timestamp: TIMESTAMP + 1 },
      TIMESTAMP,
      "block mismatch",
      "LIFECYCLE_EVENT_MISMATCH",
    ],
  ])(
    "rejects lifecycle event timing: %s",
    async (block, timestamp, _label, code) => {
      const fixture = lifecycleFixture("settle");
      fixture.provider.getBlock.mockImplementation(
        (blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"99".repeat(32)}` }
              : block,
          ),
      );
      const event = paymentInterface.encodeEventLog(
        paymentInterface.getEvent("PaymentSettled")!,
        [PAYMENT_ID, timestamp, 0n],
      );
      fixture.receipt.logs = [{ address: CONTRACT, ...event }];
      await expect(
        fixture.service.reconcileLifecycle(
          fixture.payment.id,
          "settle",
          TX_HASH,
          "biz-1",
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([
    ["sender", (state: any[]) => (state[0] = OTHER_SENDER)],
    ["recipient", (state: any[]) => (state[1] = OTHER_RECIPIENT)],
    ["amount", (state: any[]) => (state[2] = 1_400_000n)],
    ["token", (state: any[]) => (state[3] = OTHER_TOKEN)],
    ["purpose", (state: any[]) => (state[4] = OTHER_PURPOSE_HASH)],
    ["status", (state: any[]) => (state[5] = 5)],
    ["created time", (state: any[]) => (state[7] = TIMESTAMP - 101)],
    ["settled time", (state: any[]) => (state[8] = TIMESTAMP - 1)],
    ["currency", (state: any[]) => (state[9] = "0x455552")],
  ])("rejects confirmed state with mismatched %s", async (_label, mutate) => {
    const fixture = lifecycleFixture("settle");
    const state: any[] = [
      SENDER,
      RECIPIENT,
      1_500_000n,
      TOKEN,
      PURPOSE_HASH,
      4,
      "0x",
      TIMESTAMP - 100,
      TIMESTAMP,
      "0x555344",
    ];
    (mutate as (value: any[]) => void)(state);
    fixture.provider.call.mockResolvedValue(
      paymentInterface.encodeFunctionResult("getPayment", [state]),
    );
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_STATE_MISMATCH" });
  });

  it("classifies a failed historical state call", async () => {
    const fixture = lifecycleFixture("settle");
    fixture.provider.call.mockRejectedValue(new Error("archive unavailable"));
    await expect(
      fixture.service.reconcileLifecycle(
        fixture.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_STATE_MISMATCH" });
  });

  it("replays an already audited lifecycle transition exactly", async () => {
    const fixture = lifecycleFixture("settle");
    fixture.transactionDb.auditLog.findFirst.mockResolvedValue({
      id: "audit-1",
    });
    fixture.transactionDb.payment.findFirst.mockResolvedValue(
      persistedPayment({ status: "SETTLED" }),
    );
    const result = await fixture.service.reconcileLifecycle(
      fixture.payment.id,
      "settle",
      TX_HASH,
      "biz-1",
    );
    expect(result.replayed).toBe(true);
    expect(fixture.transactionDb.payment.update).not.toHaveBeenCalled();
  });

  it("rejects a missing payment or conflicting state after the lifecycle lock", async () => {
    const missing = lifecycleFixture("settle");
    missing.transactionDb.payment.findFirst.mockResolvedValue(null);
    await expect(
      missing.service.reconcileLifecycle(
        missing.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });

    const conflict = lifecycleFixture("settle");
    conflict.transactionDb.auditLog.findFirst.mockResolvedValue({
      id: "audit-1",
    });
    conflict.transactionDb.payment.findFirst.mockResolvedValue(
      persistedPayment({ status: "PENDING" }),
    );
    await expect(
      conflict.service.reconcileLifecycle(
        conflict.payment.id,
        "settle",
        TX_HASH,
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "LIFECYCLE_RECONCILIATION_CONFLICT" });
  });
});
