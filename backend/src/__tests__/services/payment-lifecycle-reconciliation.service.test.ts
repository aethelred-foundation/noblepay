import { Interface, Wallet } from "ethers";
import { Prisma } from "@prisma/client";
import { PaymentReconciliationService } from "../../services/payment-reconciliation";

const CONTRACT = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const PAYMENT_ID = `0x${"ab".repeat(32)}`;
const TX_HASH = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const iface = new Interface([
  "function cancelPayment(bytes32 _paymentId)",
  "function getPayment(bytes32) view returns ((address sender,address recipient,uint256 amount,address token,bytes32 purposeHash,uint8 status,bytes teeAttestation,uint256 createdAt,uint256 settledAt,bytes3 currencyCode))",
  "event PaymentRefunded(bytes32 indexed paymentId,uint256 refundedAt)",
]);

describe("verified payment lifecycle reconciliation", () => {
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
  beforeEach(() => {
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
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("updates Prisma only after exact cancel calldata, event, block state and tenant signer", async () => {
    const sender = Wallet.createRandom().address;
    const timestamp = 1_750_000_000;
    const event = iface.encodeEventLog(iface.getEvent("PaymentRefunded")!, [
      PAYMENT_ID,
      timestamp,
    ]);
    const payment: any = {
      id: "11111111-1111-4111-8111-111111111111",
      paymentId: PAYMENT_ID,
      sender,
      recipient: RECIPIENT,
      amount: new Prisma.Decimal("1"),
      currency: "USDC",
      purposeHash: `0x${"12".repeat(32)}`,
      status: "PENDING",
      initiatedAt: new Date((timestamp - 100) * 1000),
      blockNumber: 1n,
      businessId: "biz-1",
    };
    const updated = {
      ...payment,
      status: "CANCELLED",
      refundedAt: new Date(timestamp * 1000),
    };
    const transactionDb: any = {
      $executeRaw: jest.fn(),
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      payment: {
        findFirst: jest.fn().mockResolvedValue(payment),
        update: jest.fn().mockResolvedValue(updated),
      },
    };
    const prisma: any = {
      payment: { findFirst: jest.fn().mockResolvedValue(payment) },
      $transaction: jest.fn(async (callback: (db: any) => unknown) =>
        callback(transactionDb),
      ),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        status: 1,
        blockNumber: 77,
        blockHash: BLOCK_HASH,
        logs: [{ address: CONTRACT, ...event }],
        confirmations: jest.fn().mockResolvedValue(3),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 77,
        blockHash: BLOCK_HASH,
        to: CONTRACT,
        from: sender,
        data: iface.encodeFunctionData("cancelPayment", [PAYMENT_ID]),
        value: 0n,
      }),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"99".repeat(32)}` }
              : { number: 77, hash: BLOCK_HASH, timestamp },
          ),
        ),
      call: jest
        .fn()
        .mockResolvedValue(
          iface.encodeFunctionResult("getPayment", [
            [
              sender,
              RECIPIENT,
              1_000_000n,
              TOKEN,
              payment.purposeHash,
              5,
              "0x",
              timestamp - 100,
              0,
              "0x555344",
            ],
          ]),
        ),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const service = new PaymentReconciliationService(prisma, audit, provider);
    const result = await service.reconcileLifecycle(
      payment.id,
      "cancel",
      TX_HASH,
      "biz-1",
    );
    expect(result.payment.status).toBe("CANCELLED");
    expect(result.confirmations).toBe(3);
    expect(transactionDb.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CANCELLED",
          refundedAt: new Date(timestamp * 1000),
        }),
      }),
    );
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      transactionDb,
      expect.objectContaining({
        eventType: "PAYMENT_CANCELLED",
        txHash: TX_HASH,
      }),
    );
  });
});
