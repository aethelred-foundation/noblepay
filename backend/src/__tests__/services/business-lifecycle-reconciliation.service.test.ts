import { Interface } from "ethers";
import { Prisma } from "@prisma/client";
import { BusinessReconciliationService } from "../../services/business-reconciliation";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const NOBLEPAY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const BUSINESS = "0x4444444444444444444444444444444444444444";
const OFFICER = "0x5555555555555555555555555555555555555555";
const VERIFIER = "0x6666666666666666666666666666666666666666";
const ADMIN_SAFE = "0x7777777777777777777777777777777777777777";
const RELAYER = "0x8888888888888888888888888888888888888888";
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const TIMESTAMP = 1_750_000_000;

const registry = new Interface([
  "function verifyBusiness(address _business)",
  "function suspendBusiness(address _business,string _reason)",
  "function reinstateBusiness(address _business)",
  "function revokeBusiness(address _business,string _reason)",
  "function getBusinessDetails(address _business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "event BusinessVerified(address indexed wallet,address indexed verifier,uint256 verifiedAt)",
  "event BusinessSuspended(address indexed wallet,string reason)",
  "event BusinessReinstated(address indexed wallet,address indexed reinstatedBy)",
  "event BusinessRevoked(address indexed wallet,string reason)",
]);
const safe = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
]);

function configureEnvironment(verifier = VERIFIER) {
  process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
  process.env.NOBLEPAY_CHAIN_ID = "7332";
  process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
  process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"99".repeat(32)}`;
  process.env.NOBLEPAY_CONTRACT_ADDRESS = NOBLEPAY;
  process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY;
  process.env.BUSINESS_VERIFIER_ADDRESS = verifier;
  process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
  process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
    [TOKEN]: { currency: "USDC", currencyCode: "USD", decimals: 6 },
  });
}

function business(status: "PENDING" | "VERIFIED" | "SUSPENDED" = "VERIFIED") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    address: BUSINESS,
    licenseNumber: "DMCC123456",
    businessName: "Acme Treasury",
    jurisdiction: "UAE",
    businessType: "LLC",
    kycStatus: status,
    tier: "STANDARD",
    complianceOfficer: OFFICER,
    contactEmail: "ops@acme.test",
    registeredAt: new Date(1_700_000_000_000),
    lastVerified:
      status === "PENDING" ? null : new Date((TIMESTAMP - 100) * 1000),
    dailyLimit: new Prisma.Decimal(50_000),
    monthlyLimit: new Prisma.Decimal(500_000),
    registrationTxHash: `0x${"12".repeat(32)}`,
    registrationBlockNumber: 10n,
  } as any;
}

function safeExecution(innerData: string, target = REGISTRY, operation = 0) {
  return safe.encodeFunctionData("execTransaction", [
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

function fixture(input: {
  priorStatus: "PENDING" | "VERIFIED" | "SUSPENDED";
  method:
    | "verifyBusiness"
    | "suspendBusiness"
    | "reinstateBusiness"
    | "revokeBusiness";
  actor: string;
  safeActor?: boolean;
  reason?: string;
}) {
  const record = business(input.priorStatus);
  const args =
    input.method === "suspendBusiness" || input.method === "revokeBusiness"
      ? [BUSINESS, input.reason || "policy breach"]
      : [BUSINESS];
  const innerData = registry.encodeFunctionData(input.method, args);
  const status =
    input.method === "suspendBusiness"
      ? 2
      : input.method === "revokeBusiness"
        ? 3
        : 1;
  const eventName =
    input.method === "verifyBusiness"
      ? "BusinessVerified"
      : input.method === "suspendBusiness"
        ? "BusinessSuspended"
        : input.method === "reinstateBusiness"
          ? "BusinessReinstated"
          : "BusinessRevoked";
  const eventArgs =
    input.method === "verifyBusiness"
      ? [BUSINESS, input.actor, TIMESTAMP]
      : input.method === "reinstateBusiness"
        ? [BUSINESS, input.actor]
        : [BUSINESS, input.reason || "policy breach"];
  const event = registry.encodeEventLog(
    registry.getEvent(eventName)!,
    eventArgs,
  );
  const updated = {
    ...record,
    kycStatus:
      status === 1 ? "VERIFIED" : status === 2 ? "SUSPENDED" : "REVOKED",
    ...(input.method === "verifyBusiness" ||
    input.method === "reinstateBusiness"
      ? { lastVerified: new Date(TIMESTAMP * 1000) }
      : {}),
  };
  const database: any = {
    $executeRaw: jest.fn(),
    business: {
      findUnique: jest.fn().mockResolvedValue(record),
      update: jest.fn().mockResolvedValue(updated),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    aPIKey: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma: any = {
    business: { findUnique: jest.fn().mockResolvedValue(record) },
    $transaction: jest.fn(async (callback: (db: any) => unknown) =>
      callback(database),
    ),
  };
  const receipt: any = {
    hash: TX_HASH,
    status: 1,
    blockNumber: 99,
    blockHash: BLOCK_HASH,
    logs: [{ address: REGISTRY, ...event }],
    confirmations: jest.fn().mockResolvedValue(3),
  };
  const transaction: any = {
    hash: TX_HASH,
    blockNumber: 99,
    blockHash: BLOCK_HASH,
    to: input.safeActor ? input.actor : REGISTRY,
    from: input.safeActor ? RELAYER : input.actor,
    data: input.safeActor ? safeExecution(innerData) : innerData,
    value: 0n,
  };
  const provider: any = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue(transaction),
    getCode: jest.fn().mockResolvedValue("0x6001600055"),
    getBlock: jest.fn(async (blockTag: string | bigint) =>
      blockTag === 1n
        ? { number: 1, hash: `0x${"99".repeat(32)}` }
        : { number: 99, hash: BLOCK_HASH, timestamp: TIMESTAMP },
    ),
    call: jest.fn(async ({ data }: { data: string }) => {
      if (data.startsWith(registry.getFunction("hasRole")!.selector)) {
        return registry.encodeFunctionResult("hasRole", [true]);
      }
      return registry.encodeFunctionResult("getBusinessDetails", [
        [
          BUSINESS,
          record.licenseNumber,
          record.businessName,
          0,
          status,
          0,
          1_700_000_000,
          input.method === "verifyBusiness" ||
          input.method === "reinstateBusiness"
            ? TIMESTAMP
            : TIMESTAMP - 100,
          OFFICER,
        ],
      ]);
    }),
  };
  const audit: any = {
    createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
  };
  return {
    service: new BusinessReconciliationService(prisma, audit, provider),
    database,
    prisma,
    provider,
    transaction,
    record,
  };
}

describe("BusinessRegistry lifecycle reconciliation", () => {
  beforeEach(() => configureEnvironment());

  it("reconciles a verifier suspension", async () => {
    const current = fixture({
      priorStatus: "VERIFIED",
      method: "suspendBusiness",
      actor: VERIFIER,
      reason: "manual review",
    });
    await expect(
      current.service.reconcileSuspension(current.record.id, TX_HASH),
    ).resolves.toMatchObject({
      business: { kycStatus: "SUSPENDED" },
      replayed: false,
    });
  });

  it("reconciles a verifier reinstatement and exact verification time", async () => {
    const current = fixture({
      priorStatus: "SUSPENDED",
      method: "reinstateBusiness",
      actor: VERIFIER,
    });
    await expect(
      current.service.reconcileReinstatement(current.record.id, TX_HASH),
    ).resolves.toMatchObject({
      business: { kycStatus: "VERIFIED" },
      replayed: false,
    });
  });

  it("reconciles an admin-Safe revocation and atomically revokes API keys", async () => {
    const current = fixture({
      priorStatus: "VERIFIED",
      method: "revokeBusiness",
      actor: ADMIN_SAFE,
      safeActor: true,
      reason: "license withdrawn",
    });
    await expect(
      current.service.reconcileRevocation(current.record.id, TX_HASH),
    ).resolves.toMatchObject({
      business: { kycStatus: "REVOKED" },
      replayed: false,
    });
    expect(current.database.aPIKey.updateMany).toHaveBeenCalledWith({
      where: { businessId: current.record.id, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: expect.any(Date) },
    });
  });

  it("reconciles verification executed by the independently configured verifier Safe", async () => {
    configureEnvironment(VERIFIER);
    const current = fixture({
      priorStatus: "PENDING",
      method: "verifyBusiness",
      actor: VERIFIER,
      safeActor: true,
    });
    await expect(
      current.service.reconcileVerification(current.record.id, TX_HASH),
    ).resolves.toMatchObject({
      business: { kycStatus: "VERIFIED" },
      replayed: false,
    });
    expect(current.provider.getCode).toHaveBeenCalledWith(VERIFIER, 99);
  });

  it("rejects delegatecall Safe execution before any database mutation", async () => {
    const current = fixture({
      priorStatus: "VERIFIED",
      method: "revokeBusiness",
      actor: ADMIN_SAFE,
      safeActor: true,
    });
    const innerData = registry.encodeFunctionData("revokeBusiness", [
      BUSINESS,
      "policy breach",
    ]);
    current.transaction.data = safeExecution(innerData, REGISTRY, 1);

    await expect(
      current.service.reconcileRevocation(current.record.id, TX_HASH),
    ).rejects.toMatchObject({ code: "INVALID_BUSINESS_REGISTRY_EXECUTION" });
    expect(current.prisma.$transaction).not.toHaveBeenCalled();
  });
});
