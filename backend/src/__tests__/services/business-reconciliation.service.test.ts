import { Interface, Wallet, parseUnits } from "ethers";
import { Prisma as PrismaTypes } from "@prisma/client";
import { BusinessReconciliationService } from "../../services/business-reconciliation";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const NOBLEPAY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const OFFICER = "0x4444444444444444444444444444444444444444";
const TX_HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const registry = new Interface([
  "function verifyBusiness(address _business)",
  "function upgradeTier(address _business,uint8 _newTier)",
  "function getBusinessDetails(address _business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "function getBusinessTier(address _business) view returns (uint8)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "event BusinessVerified(address indexed wallet,address indexed verifier,uint256 verifiedAt)",
  "event TierUpgraded(address indexed wallet,uint8 oldTier,uint8 newTier)",
]);
const noblepay = new Interface([
  "function dailyVolume(address business,uint256 epoch) view returns (uint256)",
  "function monthlyVolume(address business,uint256 epoch) view returns (uint256)",
  "function getDailyLimit(uint8 tier) view returns (uint256)",
  "function getMonthlyLimit(uint8 tier) view returns (uint256)",
]);

describe("BusinessRegistry reconciliation", () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of [
      "AETHELRED_RPC_URL",
      "NOBLEPAY_CHAIN_ID",
      "AETHELRED_NETWORK_ANCHOR_BLOCK",
      "AETHELRED_NETWORK_ANCHOR_HASH",
      "NOBLEPAY_CONTRACT_ADDRESS",
      "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
      "BUSINESS_VERIFIER_ADDRESS",
      "NOBLEPAY_MIN_CONFIRMATIONS",
      "NOBLEPAY_TOKEN_CONFIG",
    ])
      original[key] = process.env[key];
  });
  beforeEach(() => {
    process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
    process.env.NOBLEPAY_CHAIN_ID = "7332";
    process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
    process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"ab".repeat(32)}`;
    process.env.NOBLEPAY_CONTRACT_ADDRESS = NOBLEPAY;
    process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY;
    process.env.BUSINESS_VERIFIER_ADDRESS = OFFICER;
    process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
    process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
      [TOKEN]: { currency: "USDC", currencyCode: "USD", decimals: 6 },
    });
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function business(wallet: string, overrides: Record<string, unknown> = {}) {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      address: wallet,
      licenseNumber: "DMCC123456",
      businessName: "Acme Treasury",
      jurisdiction: "UAE",
      businessType: "LLC",
      kycStatus: "PENDING",
      tier: "STANDARD",
      complianceOfficer: OFFICER,
      contactEmail: "ops@acme.test",
      registeredAt: new Date(1_700_000_000_000),
      lastVerified: null,
      dailyLimit: new PrismaTypes.Decimal(50_000),
      monthlyLimit: new PrismaTypes.Decimal(500_000),
      registrationTxHash: `0x${"12".repeat(32)}`,
      registrationBlockNumber: 10n,
      ...overrides,
    } as any;
  }

  it("persists verification only after exact calldata, verifier role, event and block state", async () => {
    const wallet = Wallet.createRandom().address;
    const verifier = Wallet.createRandom().address;
    process.env.BUSINESS_VERIFIER_ADDRESS = verifier;
    const timestamp = 1_750_000_000;
    const record = business(wallet);
    const updated = {
      ...record,
      kycStatus: "VERIFIED",
      lastVerified: new Date(timestamp * 1000),
    };
    const event = registry.encodeEventLog(
      registry.getEvent("BusinessVerified")!,
      [wallet, verifier, timestamp],
    );
    const database: any = {
      $executeRaw: jest.fn(),
      business: {
        findUnique: jest.fn().mockResolvedValue(record),
        update: jest.fn().mockResolvedValue(updated),
      },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma: any = {
      business: { findUnique: jest.fn().mockResolvedValue(record) },
      $transaction: jest.fn(async (callback: (db: any) => unknown) =>
        callback(database),
      ),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        status: 1,
        blockNumber: 99,
        blockHash: BLOCK_HASH,
        logs: [{ address: REGISTRY, ...event }],
        confirmations: jest.fn().mockResolvedValue(3),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 99,
        blockHash: BLOCK_HASH,
        to: REGISTRY,
        from: verifier,
        data: registry.encodeFunctionData("verifyBusiness", [wallet]),
        value: 0n,
      }),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"ab".repeat(32)}` }
              : { number: 99, hash: BLOCK_HASH, timestamp },
          ),
        ),
      call: jest.fn(async ({ data }: { data: string }) => {
        if (data.startsWith(registry.getFunction("hasRole")!.selector)) {
          return registry.encodeFunctionResult("hasRole", [true]);
        }
        return registry.encodeFunctionResult("getBusinessDetails", [
          [
            wallet,
            record.licenseNumber,
            record.businessName,
            0,
            1,
            0,
            1_700_000_000,
            timestamp,
            OFFICER,
          ],
        ]);
      }),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const result = await new BusinessReconciliationService(
      prisma,
      audit,
      provider,
    ).reconcileVerification(record.id, TX_HASH);

    expect(result.business.kycStatus).toBe("VERIFIED");
    expect(result.replayed).toBe(false);
    expect(database.business.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          kycStatus: "VERIFIED",
          lastVerified: new Date(timestamp * 1000),
        },
      }),
    );
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      database,
      expect.objectContaining({
        eventType: "BUSINESS_VERIFIED",
        actor: verifier,
        txHash: TX_HASH,
      }),
    );
  });

  it("does not persist BusinessRegistry state from an orphaned receipt", async () => {
    const wallet = Wallet.createRandom().address;
    const verifier = Wallet.createRandom().address;
    const record = business(wallet);
    const prisma: any = {
      business: { findUnique: jest.fn().mockResolvedValue(record) },
      $transaction: jest.fn(),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        status: 1,
        blockNumber: 99,
        blockHash: BLOCK_HASH,
        logs: [],
        confirmations: jest.fn().mockResolvedValue(3),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 99,
        blockHash: BLOCK_HASH,
        to: REGISTRY,
        from: verifier,
        data: registry.encodeFunctionData("verifyBusiness", [wallet]),
        value: 0n,
      }),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"ab".repeat(32)}` }
              : { number: 99, hash: `0x${"de".repeat(32)}` },
          ),
        ),
      call: jest.fn(),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn(),
    };

    await expect(
      new BusinessReconciliationService(
        prisma,
        audit,
        provider,
      ).reconcileVerification(record.id, TX_HASH),
    ).rejects.toMatchObject({ code: "TRANSACTION_CANONICAL_MISMATCH" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.createAuditEntryInTransaction).not.toHaveBeenCalled();
    expect(provider.call).not.toHaveBeenCalled();
  });

  it("requires the explicit requested tier to match upgrade calldata, event and state", async () => {
    const wallet = Wallet.createRandom().address;
    const admin = Wallet.createRandom().address;
    const record = business(wallet, {
      kycStatus: "VERIFIED",
      lastVerified: new Date(1_740_000_000 * 1000),
    });
    const updated = {
      ...record,
      tier: "PREMIUM",
      dailyLimit: new PrismaTypes.Decimal(500_000),
      monthlyLimit: new PrismaTypes.Decimal(5_000_000),
    };
    const event = registry.encodeEventLog(registry.getEvent("TierUpgraded")!, [
      wallet,
      0,
      1,
    ]);
    const database: any = {
      $executeRaw: jest.fn(),
      business: {
        findUnique: jest.fn().mockResolvedValue(record),
        update: jest.fn().mockResolvedValue(updated),
      },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma: any = {
      business: { findUnique: jest.fn().mockResolvedValue(record) },
      $transaction: jest.fn(async (callback: (db: any) => unknown) =>
        callback(database),
      ),
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        status: 1,
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        logs: [{ address: REGISTRY, ...event }],
        confirmations: jest.fn().mockResolvedValue(3),
      }),
      getTransaction: jest.fn().mockResolvedValue({
        hash: TX_HASH,
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        to: REGISTRY,
        from: admin,
        data: registry.encodeFunctionData("upgradeTier", [wallet, 1]),
        value: 0n,
      }),
      getBlock: jest.fn().mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: `0x${"ab".repeat(32)}` }
            : {
                number: 100,
                hash: BLOCK_HASH,
                timestamp: 1_750_000_100,
              },
        ),
      ),
      call: jest.fn(async ({ data }: { data: string }) => {
        if (data.startsWith(registry.getFunction("hasRole")!.selector)) {
          return registry.encodeFunctionResult("hasRole", [true]);
        }
        return registry.encodeFunctionResult("getBusinessDetails", [
          [
            wallet,
            record.licenseNumber,
            record.businessName,
            0,
            1,
            1,
            1_700_000_000,
            1_740_000_000,
            OFFICER,
          ],
        ]);
      }),
    };
    const audit: any = {
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    const service = new BusinessReconciliationService(prisma, audit, provider);

    await expect(
      service.reconcileTierUpgrade(record.id, "ENTERPRISE", TX_HASH),
    ).rejects.toMatchObject({
      code: "BUSINESS_TIER_CLAIM_MISMATCH",
    });
    const result = await service.reconcileTierUpgrade(
      record.id,
      "PREMIUM",
      TX_HASH,
    );
    expect(result.business.tier).toBe("PREMIUM");
    expect(database.business.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tier: "PREMIUM",
          dailyLimit: 500_000,
          monthlyLimit: 5_000_000,
        }),
      }),
    );
  });

  it("reports contract epoch usage instead of reversible database calendar totals", async () => {
    const wallet = Wallet.createRandom().address;
    const timestamp = 1_750_000_000;
    const record = business(wallet, { kycStatus: "VERIFIED", tier: "PREMIUM" });
    const prisma: any = {
      business: { findUnique: jest.fn().mockResolvedValue(record) },
    };
    const provider: any = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"ab".repeat(32)}` }
              : { number: 120, timestamp },
          ),
        ),
      call: jest.fn(async ({ to, data }: { to: string; data: string }) => {
        if (to === REGISTRY)
          return registry.encodeFunctionResult("getBusinessTier", [1]);
        if (data.startsWith(noblepay.getFunction("dailyVolume")!.selector)) {
          return noblepay.encodeFunctionResult("dailyVolume", [
            parseUnits("125", 6),
          ]);
        }
        if (data.startsWith(noblepay.getFunction("monthlyVolume")!.selector)) {
          return noblepay.encodeFunctionResult("monthlyVolume", [
            parseUnits("1000", 6),
          ]);
        }
        if (data.startsWith(noblepay.getFunction("getDailyLimit")!.selector)) {
          return noblepay.encodeFunctionResult("getDailyLimit", [
            parseUnits("500000", 6),
          ]);
        }
        return noblepay.encodeFunctionResult("getMonthlyLimit", [
          parseUnits("5000000", 6),
        ]);
      }),
    };
    const result = await new BusinessReconciliationService(
      prisma,
      {} as any,
      provider,
    ).getOnChainLimits(record.id);

    expect(result).toMatchObject({
      tier: "PREMIUM",
      mirrorInSync: true,
      source: "onchain",
      daily: { used: "125.0", limit: "500000.0", remaining: "499875.0" },
      monthly: {
        used: "1000.0",
        limit: "5000000.0",
        remaining: "4999000.0",
        epochKind: "30-day",
      },
    });
  });
});
