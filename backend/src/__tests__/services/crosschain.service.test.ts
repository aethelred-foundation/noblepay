const mockVerifyInitiation = jest.fn();
const mockVerifyRecovery = jest.fn();

jest.mock("../../services/crosschain-execution", () => ({
  verifyTransferInitiation: (...a: unknown[]) => mockVerifyInitiation(...a),
  verifyTransferRecovery: (...a: unknown[]) => mockVerifyRecovery(...a),
}));

import { Prisma } from "@prisma/client";
import { CrossChainService } from "../../services/crosschain";
import type { AuditService } from "../../services/audit";

const wallet = "0x1111111111111111111111111111111111111111";

const chainConfig = [
  {
    id: "aethelred",
    chainId: 7332,
    name: "Aethelred Testnet",
    type: "EVM",
    rpcUrl: "https://rpc.aethelred.example",
    explorer: "https://explorer.aethelred.example",
    avgBlockTime: 2,
    finality: 12,
    nativeToken: "AETHEL",
    supportedTokens: ["USDC", "USDT"],
  },
  {
    id: "ethereum",
    chainId: 11155111,
    name: "Ethereum Sepolia",
    type: "EVM",
    rpcUrl: "https://rpc.ethereum.example",
    explorer: "https://explorer.ethereum.example",
    avgBlockTime: 12,
    finality: 12,
    nativeToken: "ETH",
    supportedTokens: ["USDC"],
  },
];

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    id: "transfer-1",
    sourceChain: "aethelred",
    destChain: "ethereum",
    currency: "USDC",
    amount: new Prisma.Decimal("250"),
    sender: wallet,
    recipient: "0x2222222222222222222222222222222222222222",
    status: "COMPLETED",
    sourceTxHash: "0xsource",
    destTxHash: "0xdest",
    bridgeFee: new Prisma.Decimal("1.5"),
    estimatedTime: 90,
    relayNode: "relay-1",
    initiatedAt: new Date("2026-07-21T11:00:00.000Z"),
    completedAt: new Date("2026-07-21T11:01:30.000Z"),
    metadata: { steps: [] },
    ...overrides,
  };
}

function setup(chainProbe = jest.fn()) {
  const prisma = {
    business: { findUnique: jest.fn() },
    crossChainTransfer: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    relayNode: { findMany: jest.fn(), count: jest.fn() },
  };
  const auditService = { createAuditEntry: jest.fn() };
  const service = new CrossChainService(
    prisma as never,
    auditService as unknown as AuditService,
    chainProbe as never,
  );
  return { prisma, service, chainProbe, auditService };
}

describe("CrossChainService production behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // The verifier mocks live at module scope, so they carry call history
    // between tests unless cleared here. setup() builds fresh prisma mocks per
    // call, so clearing everything is safe.
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      CROSSCHAIN_CHAINS_JSON: JSON.stringify(chainConfig),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reports chain health only after probing each configured RPC", async () => {
    const { service, chainProbe } = setup();
    chainProbe
      .mockResolvedValueOnce({ chainId: 7332, gasPrice: 12n })
      .mockRejectedValueOnce(new Error("RPC down"));

    const chains = await service.getChains();

    expect(chains).toEqual([
      expect.objectContaining({
        id: "aethelred",
        status: "ONLINE",
        currentGasPrice: "12",
      }),
      expect.objectContaining({
        id: "ethereum",
        status: "OFFLINE",
        currentGasPrice: null,
      }),
    ]);
    expect(chainProbe).toHaveBeenCalledTimes(2);
  });

  it("marks a chain offline when the RPC reports the wrong chain ID", async () => {
    const { service, chainProbe } = setup();
    chainProbe
      .mockResolvedValueOnce({ chainId: 1, gasPrice: 12n })
      .mockResolvedValueOnce({ chainId: 11155111, gasPrice: null });

    const chains = await service.getChains();

    expect(chains[0]).toMatchObject({ id: "aethelred", status: "OFFLINE" });
    expect(chains[1]).toMatchObject({
      id: "ethereum",
      status: "ONLINE",
      currentGasPrice: null,
    });
  });

  it("never fabricates a route when no signed quote provider exists", async () => {
    const { service, chainProbe } = setup();
    chainProbe.mockImplementation(async (chain: { chainId: number }) => ({
      chainId: chain.chainId,
      gasPrice: 1n,
    }));

    await expect(
      service.getRoutes("aethelred", "ethereum", "USDC", "100"),
    ).rejects.toMatchObject({
      code: "ROUTE_QUOTE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it.each([
    ["missing source", "", "ethereum", "USDC", "1", "INVALID_ROUTE"],
    ["same chain", "aethelred", "aethelred", "USDC", "1", "INVALID_ROUTE"],
    [
      "missing token",
      "aethelred",
      "ethereum",
      "",
      "1",
      "INVALID_QUOTE_REQUEST",
    ],
    [
      "non-finite amount",
      "aethelred",
      "ethereum",
      "USDC",
      "NaN",
      "INVALID_QUOTE_REQUEST",
    ],
    [
      "non-positive amount",
      "aethelred",
      "ethereum",
      "USDC",
      "0",
      "INVALID_QUOTE_REQUEST",
    ],
  ])(
    "rejects a %s quote before contacting any RPC",
    async (_name, source, destination, token, amount, code) => {
      const { service, chainProbe } = setup();

      await expect(
        service.getRoutes(source, destination, token, amount),
      ).rejects.toMatchObject({ code });
      expect(chainProbe).not.toHaveBeenCalled();
    },
  );

  it("distinguishes unknown chains from unavailable chain RPCs", async () => {
    const { service, chainProbe } = setup();
    chainProbe.mockImplementation(async (chain: { chainId: number }) => ({
      chainId: chain.chainId,
      gasPrice: 1n,
    }));

    await expect(
      service.getRoutes("unknown", "ethereum", "USDC", "1"),
    ).rejects.toMatchObject({ code: "CHAIN_NOT_FOUND", statusCode: 404 });

    chainProbe.mockReset();
    chainProbe
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ chainId: 11155111, gasPrice: 1n });
    await expect(
      service.getRoutes("aethelred", "ethereum", "USDC", "1"),
    ).rejects.toMatchObject({
      code: "CHAIN_RPC_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it.each([
    [undefined, "CHAIN_REGISTRY_UNAVAILABLE"],
    ["not-json", "CHAIN_REGISTRY_MISCONFIGURED"],
    ["[]", "CHAIN_REGISTRY_MISCONFIGURED"],
  ])("rejects an unusable chain registry: %p", async (value, code) => {
    const { service, chainProbe } = setup();
    if (value === undefined) delete process.env.CROSSCHAIN_CHAINS_JSON;
    else process.env.CROSSCHAIN_CHAINS_JSON = value;

    await expect(service.getChains()).rejects.toMatchObject({
      code,
      statusCode: 503,
    });
    expect(chainProbe).not.toHaveBeenCalled();
  });

  it("rejects duplicate chain identifiers and malformed registry URLs", async () => {
    const { service, chainProbe } = setup();
    process.env.CROSSCHAIN_CHAINS_JSON = JSON.stringify([
      chainConfig[0],
      { ...chainConfig[1], id: chainConfig[0].id },
    ]);
    await expect(service.getChains()).rejects.toMatchObject({
      code: "CHAIN_REGISTRY_MISCONFIGURED",
    });

    process.env.CROSSCHAIN_CHAINS_JSON = JSON.stringify([
      { ...chainConfig[0], rpcUrl: "not-a-url" },
    ]);
    await expect(service.getChains()).rejects.toMatchObject({
      code: "CHAIN_REGISTRY_MISCONFIGURED",
    });
    expect(chainProbe).not.toHaveBeenCalled();
  });

  it("requires HTTPS registry endpoints in production", async () => {
    const { service, chainProbe } = setup();
    process.env.NODE_ENV = "production";
    process.env.CROSSCHAIN_CHAINS_JSON = JSON.stringify([
      { ...chainConfig[0], explorer: "http://explorer.internal" },
    ]);

    await expect(service.getChains()).rejects.toMatchObject({
      code: "CHAIN_REGISTRY_MISCONFIGURED",
      statusCode: 503,
    });
    expect(chainProbe).not.toHaveBeenCalled();
  });

  it("tenant-scopes and paginates transfer history", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.crossChainTransfer.findMany.mockResolvedValue([transfer()]);

    const records = await service.listTransfers({
      businessId: "business-1",
      sender: wallet,
      status: "COMPLETED",
      page: 2,
      limit: 25,
    });

    expect(records[0]).toEqual(
      expect.objectContaining({
        businessId: "business-1",
        bridgeFee: "1.5",
        dataSource: "DATABASE_LEDGER",
      }),
    );
    expect(prisma.crossChainTransfer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 25, take: 25 }),
    );
  });

  it("rejects cross-tenant sender filters before querying transfers", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });

    await expect(
      service.listTransfers({
        businessId: "business-1",
        sender: "0x3333333333333333333333333333333333333333",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(prisma.crossChainTransfer.findMany).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated business no longer exists", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue(null);

    await expect(
      service.listTransfers({ businessId: "missing-business" }),
    ).rejects.toMatchObject({ code: "BUSINESS_NOT_FOUND", statusCode: 404 });
    expect(prisma.crossChainTransfer.findMany).not.toHaveBeenCalled();
  });

  it("reads one tenant-owned transfer and sanitizes persisted step metadata", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.crossChainTransfer.findFirst.mockResolvedValue(
      transfer({
        bridgeFee: null,
        metadata: {
          steps: [
            null,
            { step: "1", name: "invalid", status: "COMPLETED" },
            {
              step: 1,
              name: "source_finality",
              status: "COMPLETED",
              txHash: "0xsource",
              timestamp: "2026-07-21T11:00:30.000Z",
              details: "12 confirmations",
            },
            {
              step: 2,
              name: "destination_mint",
              status: "PENDING",
              timestamp: "not-a-date",
            },
          ],
        },
      }),
    );

    const record = await service.getTransfer("transfer-1", "business-1");

    expect(record.bridgeFee).toBeNull();
    expect(record.steps).toEqual([
      expect.objectContaining({
        step: 1,
        txHash: "0xsource",
        timestamp: new Date("2026-07-21T11:00:30.000Z"),
        details: "12 confirmations",
      }),
      expect.objectContaining({
        step: 2,
        txHash: null,
        timestamp: null,
        details: "",
      }),
    ]);
    expect(prisma.crossChainTransfer.findFirst).toHaveBeenCalledWith({
      where: {
        id: "transfer-1",
        sender: { equals: wallet, mode: "insensitive" },
      },
    });
  });

  it("conceals a missing or foreign transfer behind a tenant-scoped 404", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.crossChainTransfer.findFirst.mockResolvedValue(null);

    await expect(
      service.getTransfer("foreign-transfer", "business-1"),
    ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND", statusCode: 404 });
  });

  describe("bridge initiation", () => {
    const chainCfg = { rpcUrl: "http://rpc.invalid", minimumConfirmations: 3 };
    const receipt = {
      txHash: `0x${"c".repeat(64)}`,
      onChainTransferId: `0x${"d".repeat(64)}`,
    };
    const input = {
      sourceChain: "aethelred",
      destinationChain: "ethereum",
      token: "USDC",
      amount: "1",
      recipient: "0x2222222222222222222222222222222222222222",
    };

    const verified = {
      onChainTransferId: receipt.onChainTransferId,
      sender: wallet,
      sourceToken: "0x4444444444444444444444444444444444444444",
      amount: "1000000",
      fee: "2500",
      destinationChainId: 11155111,
      recipientHash: `0x${"e".repeat(64)}`,
      txHash: receipt.txHash,
      blockNumber: 8811,
      initiatedAt: new Date("2026-07-21T11:00:00.000Z"),
      chainStatus: "INITIATED" as const,
    };

    it("verifies the escrow against the DESTINATION chain's id, not its name", async () => {
      // The service must translate the configured chain id into the numeric
      // chain id the event carries; passing the string through would make the
      // destination check unenforceable.
      const { prisma, service } = setup();
      prisma.crossChainTransfer.findFirst.mockResolvedValue(null);
      prisma.crossChainTransfer.create.mockResolvedValue(
        transfer({ status: "INITIATED" }),
      );
      mockVerifyInitiation.mockResolvedValue(verified);

      await service.initiateTransfer(
        input,
        wallet,
        "business-1",
        receipt,
        chainCfg as never,
      );

      expect(mockVerifyInitiation).toHaveBeenCalledWith(
        chainCfg,
        expect.objectContaining({
          expectedSender: wallet,
          expectedRecipient: input.recipient,
          expectedDestinationChainId: 11155111,
        }),
      );
    });

    it("records the chain's raw amount in metadata, not in the human-units column", async () => {
      // The column is Decimal(36,18) and read as human units everywhere else;
      // writing raw base units into it would silently corrupt every reader.
      const { prisma, service } = setup();
      prisma.crossChainTransfer.findFirst.mockResolvedValue(null);
      prisma.crossChainTransfer.create.mockResolvedValue(
        transfer({ status: "INITIATED" }),
      );
      mockVerifyInitiation.mockResolvedValue(verified);

      await service.initiateTransfer(
        input,
        wallet,
        "business-1",
        receipt,
        chainCfg as never,
      );

      const written = prisma.crossChainTransfer.create.mock.calls[0][0].data;
      expect(written.amount.toString()).toBe("1");
      expect(written.metadata.onChain.amount).toBe("1000000");
      expect(written.metadata.onChain.amountBasis).toBe("RAW_TOKEN_BASE_UNITS");
      expect(written.metadata.onChain.unverifiedFields).toContain(
        "amount(human)",
      );
    });

    it("returns the existing record when the same receipt is replayed", async () => {
      const { prisma, service } = setup();
      prisma.crossChainTransfer.findFirst.mockResolvedValue(
        transfer({
          onChainTransferId: receipt.onChainTransferId.toLowerCase(),
          sourceTxHash: receipt.txHash.toLowerCase(),
        }),
      );

      const result = await service.initiateTransfer(
        input,
        wallet,
        "business-1",
        receipt,
        chainCfg as never,
      );

      expect(result.id).toBe("transfer-1");
      expect(prisma.crossChainTransfer.create).not.toHaveBeenCalled();
      expect(mockVerifyInitiation).not.toHaveBeenCalled();
    });

    it("refuses a SECOND, different receipt for the same on-chain transfer", async () => {
      // Not a retry — a contradiction. One escrow cannot have two transactions.
      const { prisma, service } = setup();
      prisma.crossChainTransfer.findFirst.mockResolvedValue(
        transfer({
          onChainTransferId: receipt.onChainTransferId.toLowerCase(),
          sourceTxHash: `0x${"9".repeat(64)}`,
        }),
      );

      await expect(
        service.initiateTransfer(
          input,
          wallet,
          "business-1",
          receipt,
          chainCfg as never,
        ),
      ).rejects.toMatchObject({
        code: "TRANSFER_ALREADY_RECORDED",
        statusCode: 409,
      });
    });

    it("refuses an unconfigured destination chain before touching the RPC", async () => {
      const { prisma, service } = setup();
      prisma.crossChainTransfer.findFirst.mockResolvedValue(null);

      await expect(
        service.initiateTransfer(
          { ...input, destinationChain: "solana" },
          wallet,
          "business-1",
          receipt,
          chainCfg as never,
        ),
      ).rejects.toMatchObject({ code: "CHAIN_NOT_FOUND", statusCode: 404 });
      expect(mockVerifyInitiation).not.toHaveBeenCalled();
    });
  });

  describe("bridge recovery", () => {
    const chainCfg = { rpcUrl: "http://rpc.invalid", minimumConfirmations: 3 };
    const txHash = `0x${"f".repeat(64)}`;

    it("refuses to match a refund receipt to a row with no on-chain id", async () => {
      // Guessing which transfer a refund belongs to is not recovery.
      const { prisma, service } = setup();
      prisma.business.findUnique.mockResolvedValue({ address: wallet });
      prisma.crossChainTransfer.findFirst.mockResolvedValue(
        transfer({ status: "STUCK", onChainTransferId: null }),
      );

      await expect(
        service.recoverTransfer(
          "transfer-1",
          wallet,
          "business-1",
          { txHash },
          chainCfg as never,
        ),
      ).rejects.toMatchObject({
        code: "TRANSFER_NOT_ON_CHAIN",
        statusCode: 409,
      });
      expect(mockVerifyRecovery).not.toHaveBeenCalled();
    });

    it("is idempotent once a transfer is already recovered", async () => {
      const { prisma, service } = setup();
      prisma.business.findUnique.mockResolvedValue({ address: wallet });
      prisma.crossChainTransfer.findFirst.mockResolvedValue(
        transfer({ status: "RECOVERED" }),
      );

      const result = await service.recoverTransfer(
        "transfer-1",
        wallet,
        "business-1",
        { txHash },
        chainCfg as never,
      );

      expect(result.status).toBe("RECOVERED");
      expect(mockVerifyRecovery).not.toHaveBeenCalled();
      expect(prisma.crossChainTransfer.update).not.toHaveBeenCalled();
    });

    it("binds the refund to the transfer's own sender", async () => {
      const { prisma, service } = setup();
      prisma.business.findUnique.mockResolvedValue({ address: wallet });
      prisma.crossChainTransfer.findFirst.mockResolvedValue(
        transfer({
          status: "STUCK",
          onChainTransferId: `0x${"d".repeat(64)}`,
        }),
      );
      prisma.crossChainTransfer.update.mockResolvedValue(
        transfer({ status: "RECOVERED" }),
      );
      mockVerifyRecovery.mockResolvedValue({
        onChainTransferId: `0x${"d".repeat(64)}`,
        sender: wallet,
        refundAmount: "1002500",
        txHash,
        blockNumber: 8811,
        recoveredAt: new Date("2026-07-21T12:00:00.000Z"),
      });

      await service.recoverTransfer(
        "transfer-1",
        wallet,
        "business-1",
        { txHash },
        chainCfg as never,
      );

      expect(mockVerifyRecovery).toHaveBeenCalledWith(
        chainCfg,
        expect.objectContaining({ expectedSender: wallet, txHash }),
      );
    });
  });

  it("returns only persisted relay registry records with bounded pagination", async () => {
    const { prisma, service } = setup();
    prisma.relayNode.findMany.mockResolvedValue([
      {
        id: "relay-1",
        address: wallet,
        chains: ["aethelred", "ethereum"],
        stake: new Prisma.Decimal("500"),
        successRate: new Prisma.Decimal("98.5"),
        totalRelayed: 12,
        avgLatency: 500,
        isActive: true,
        registeredAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);

    const relays = await service.getRelayNodes({ page: 1, limit: 10 });

    expect(relays[0]).toEqual(
      expect.objectContaining({
        successRate: 98.5,
        uptime: null,
        dataSource: "DATABASE_REGISTRY",
      }),
    );
    expect(prisma.relayNode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 10 }),
    );
  });

  it("maps inactive relays and supports an unpaginated registry read", async () => {
    const { prisma, service } = setup();
    prisma.relayNode.findMany.mockResolvedValue([
      {
        id: "relay-2",
        address: wallet,
        chains: ["aethelred"],
        stake: new Prisma.Decimal("0"),
        successRate: new Prisma.Decimal("0"),
        totalRelayed: 0,
        avgLatency: 0,
        isActive: false,
        registeredAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);

    const relays = await service.getRelayNodes();

    expect(relays[0].status).toBe("INACTIVE");
    expect(prisma.relayNode.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: undefined, take: undefined }),
    );
  });

  it("derives bridge analytics from tenant-scoped durable transfers", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.crossChainTransfer.findMany.mockResolvedValue([
      transfer(),
      transfer({
        id: "transfer-2",
        amount: new Prisma.Decimal("50"),
        status: "STUCK",
        completedAt: null,
        sourceChain: "ethereum",
        destChain: "aethelred",
      }),
      transfer({
        id: "transfer-3",
        amount: new Prisma.Decimal("25"),
        status: "COMPLETED",
      }),
    ]);
    prisma.relayNode.count.mockResolvedValue(2);

    const analytics = await service.getAnalytics("business-1");

    expect(analytics).toMatchObject({
      totalTransfers: 3,
      totalVolume: "325",
      successRate: 2 / 3,
      avgSettlementTime: 90,
      activeRelayNodes: 2,
      stuckTransfers: 1,
      dataSource: "DATABASE_LEDGER",
    });
    expect(analytics.topCorridors[0]).toEqual({
      source: "aethelred",
      destination: "ethereum",
      volume: "275",
      count: 2,
    });
    expect(analytics.byChain.aethelred).toEqual({
      inbound: "50",
      outbound: "275",
      transfers: 3,
    });
    expect(prisma.relayNode.count).toHaveBeenCalledWith({
      where: { isActive: true },
    });
  });

  it("returns explicit null rates for an empty analytics ledger", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.crossChainTransfer.findMany.mockResolvedValue([]);
    prisma.relayNode.count.mockResolvedValue(0);

    await expect(service.getAnalytics("business-1")).resolves.toMatchObject({
      totalTransfers: 0,
      avgSettlementTime: null,
      successRate: null,
      topCorridors: [],
      byChain: {},
    });
  });
});
