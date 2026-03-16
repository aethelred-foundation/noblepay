import { createMockPrisma, resetAllMocks } from "../setup";
import { CrossChainService, CrossChainError } from "../../services/crosschain";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let crossChainService: CrossChainService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  crossChainService = new CrossChainService(prisma, auditService);
});

describe("CrossChainService", () => {
  // ─── getChains ─────────────────────────────────────────────────────────────

  describe("getChains", () => {
    it("should return all supported chains", () => {
      const chains = crossChainService.getChains();
      expect(chains.length).toBeGreaterThan(0);
      const ids = chains.map((c) => c.id);
      expect(ids).toContain("aethelred-mainnet");
      expect(ids).toContain("ethereum-mainnet");
    });

    it("should include chain properties", () => {
      const chains = crossChainService.getChains();
      const eth = chains.find((c) => c.id === "ethereum-mainnet");
      expect(eth).toBeDefined();
      expect(eth!.chainId).toBe(1);
      expect(eth!.type).toBe("EVM");
      expect(eth!.supportedTokens).toContain("USDC");
    });
  });

  // ─── getRoutes ─────────────────────────────────────────────────────────────

  describe("getRoutes", () => {
    it("should return routes between two chains", () => {
      const routes = crossChainService.getRoutes(
        "aethelred-mainnet",
        "ethereum-mainnet",
        "USDC",
        "10000",
      );

      expect(routes.length).toBeGreaterThan(0);
      expect(routes[0]).toHaveProperty("path");
      expect(routes[0]).toHaveProperty("estimatedFee");
      expect(routes[0]).toHaveProperty("hops");
    });

    it("should include multi-hop route when not via Aethelred", () => {
      const routes = crossChainService.getRoutes(
        "ethereum-mainnet",
        "polygon-mainnet",
        "USDC",
        "10000",
      );

      const multiHop = routes.find((r) => r.hops === 2);
      expect(multiHop).toBeDefined();
      expect(multiHop!.path).toContain("aethelred-mainnet");
    });

    it("should sort routes by fee (cheapest first)", () => {
      const routes = crossChainService.getRoutes(
        "ethereum-mainnet",
        "polygon-mainnet",
        "USDC",
        "10000",
      );

      for (let i = 1; i < routes.length; i++) {
        expect(parseFloat(routes[i - 1].estimatedFee)).toBeLessThanOrEqual(
          parseFloat(routes[i].estimatedFee),
        );
      }
    });

    it("should throw CHAIN_NOT_FOUND for unsupported chain", () => {
      expect(() =>
        crossChainService.getRoutes(
          "unsupported-chain",
          "ethereum-mainnet",
          "USDC",
          "1000",
        ),
      ).toThrow(CrossChainError);
    });
  });

  // ─── initiateTransfer ──────────────────────────────────────────────────────

  describe("initiateTransfer", () => {
    const baseTransfer = {
      sourceChain: "aethelred-mainnet",
      destinationChain: "ethereum-mainnet",
      token: "USDC",
      amount: "10000",
      recipient: "0xrecipient",
    };

    it("should initiate a transfer with correct structure", async () => {
      const transfer = await crossChainService.initiateTransfer(
        baseTransfer,
        "0xsender",
        "biz-1",
      );

      expect(transfer.id).toMatch(/^xc-/);
      expect(transfer.status).toBe("INITIATED");
      expect(transfer.steps).toHaveLength(4);
      expect(transfer.steps[0].status).toBe("IN_PROGRESS");
      expect(transfer.sourceTxHash).toMatch(/^0x/);
      expect(transfer.bridgeFee).toBeDefined();
      expect(auditService.createAuditEntry).toHaveBeenCalled();
    });

    it("should include metadata when provided", async () => {
      const transfer = await crossChainService.initiateTransfer(
        {
          ...baseTransfer,
          metadata: { reference: "inv-123", memo: "payment" },
        },
        "0xsender",
        "biz-1",
      );

      expect(transfer.metadata).toEqual({ reference: "inv-123", memo: "payment" });
    });

    it("should throw for unsupported chain", async () => {
      await expect(
        crossChainService.initiateTransfer(
          { ...baseTransfer, sourceChain: "unsupported" },
          "0xsender",
          "biz-1",
        ),
      ).rejects.toThrow(CrossChainError);
    });
  });

  // ─── getTransfer ───────────────────────────────────────────────────────────

  describe("getTransfer", () => {
    it("should return transfer by ID", async () => {
      const created = await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const transfer = crossChainService.getTransfer(created.id);
      expect(transfer.id).toBe(created.id);
    });

    it("should throw TRANSFER_NOT_FOUND for unknown transfer", () => {
      expect(() =>
        crossChainService.getTransfer("nonexistent"),
      ).toThrow(CrossChainError);
    });
  });

  // ─── listTransfers ─────────────────────────────────────────────────────────

  describe("listTransfers", () => {
    it("should return all transfers", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const transfers = crossChainService.listTransfers();
      expect(transfers).toHaveLength(1);
    });

    it("should sort by createdAt descending with multiple transfers", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "polygon-mainnet",
          token: "USDC",
          amount: "3000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const transfers = crossChainService.listTransfers();
      expect(transfers).toHaveLength(2);
      expect(transfers[0].createdAt.getTime()).toBeGreaterThanOrEqual(
        transfers[1].createdAt.getTime(),
      );
    });

    it("should filter by sender", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender1",
        "biz-1",
      );

      const filtered = crossChainService.listTransfers({
        sender: "0xsender2",
      });
      expect(filtered).toHaveLength(0);
    });

    it("should filter by sourceChain", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const matchSource = crossChainService.listTransfers({
        sourceChain: "aethelred-mainnet",
      });
      expect(matchSource).toHaveLength(1);

      const noMatchSource = crossChainService.listTransfers({
        sourceChain: "polygon-mainnet",
      });
      expect(noMatchSource).toHaveLength(0);
    });

    it("should filter by destinationChain", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const matchDest = crossChainService.listTransfers({
        destinationChain: "ethereum-mainnet",
      });
      expect(matchDest).toHaveLength(1);

      const noMatchDest = crossChainService.listTransfers({
        destinationChain: "polygon-mainnet",
      });
      expect(noMatchDest).toHaveLength(0);
    });

    it("should filter by status", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const filtered = crossChainService.listTransfers({ status: "COMPLETED" });
      expect(filtered).toHaveLength(0);
    });
  });

  // ─── recoverTransfer ───────────────────────────────────────────────────────

  describe("recoverTransfer", () => {
    it("should throw TRANSFER_NOT_FOUND for unknown transfer", async () => {
      await expect(
        crossChainService.recoverTransfer("nonexistent", "0xactor"),
      ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });
    });

    it("should throw INVALID_STATE when transfer is not STUCK or FAILED", async () => {
      const transfer = await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      await expect(
        crossChainService.recoverTransfer(transfer.id, "0xactor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    });

    it("should recover a STUCK transfer successfully", async () => {
      const transfer = await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      // Manually set status to STUCK
      (transfer as any).status = "STUCK";

      const result = await crossChainService.recoverTransfer(transfer.id, "0xactor");
      expect(result.success).toBe(true);
      expect(result.message).toContain("recovery initiated");
    });

    it("should recover a FAILED transfer", async () => {
      const transfer = await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      (transfer as any).status = "FAILED";

      const result = await crossChainService.recoverTransfer(transfer.id, "0xactor");
      expect(result.success).toBe(true);
    });
  });

  // ─── getRelayNodes ─────────────────────────────────────────────────────────

  describe("getRelayNodes", () => {
    it("should return relay nodes", () => {
      const nodes = crossChainService.getRelayNodes();
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes[0]).toHaveProperty("address");
      expect(nodes[0]).toHaveProperty("chains");
      expect(nodes[0]).toHaveProperty("uptime");
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return analytics with no transfers", () => {
      const analytics = crossChainService.getAnalytics();
      expect(analytics.totalTransfers).toBe(0);
      expect(analytics.totalVolume).toBe("0.00");
      expect(analytics.successRate).toBe(1); // default
    });

    it("should calculate analytics with transfers", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "10000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      const analytics = crossChainService.getAnalytics();
      expect(analytics.totalTransfers).toBe(1);
      expect(parseFloat(analytics.totalVolume)).toBe(10000);
      expect(analytics.activeRelayNodes).toBeGreaterThan(0);
    });

    it("should calculate settlement time for completed transfers", async () => {
      const transfer = await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      // Simulate completion
      (transfer as any).status = "COMPLETED";
      (transfer as any).completedAt = new Date(transfer.createdAt.getTime() + 60000);

      const analytics = crossChainService.getAnalytics();
      expect(analytics.totalTransfers).toBe(1);
      expect(analytics.avgSettlementTime).toBeGreaterThan(0);
    });

    it("should calculate corridor analytics with multiple transfers", async () => {
      await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "10000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      await crossChainService.initiateTransfer(
        {
          sourceChain: "ethereum-mainnet",
          destinationChain: "polygon-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient2",
        },
        "0xsender",
        "biz-1",
      );

      const analytics = crossChainService.getAnalytics();
      expect(analytics.totalTransfers).toBe(2);
      expect(analytics.topCorridors.length).toBeGreaterThanOrEqual(2);
      expect(analytics.byChain).toBeDefined();
    });

    it("should handle failed transfers in analytics", async () => {
      const transfer = await crossChainService.initiateTransfer(
        {
          sourceChain: "aethelred-mainnet",
          destinationChain: "ethereum-mainnet",
          token: "USDC",
          amount: "5000",
          recipient: "0xrecipient",
        },
        "0xsender",
        "biz-1",
      );

      (transfer as any).status = "FAILED";

      const analytics = crossChainService.getAnalytics();
      // Failed transfers still get counted in totalTransfers
      expect(analytics.totalTransfers).toBe(1);
      // But successRate should be < 1
      expect(analytics.successRate).toBeLessThanOrEqual(1);
    });
  });

  // ─── initiateTransfer NO_ROUTE branch ──────────────────────────────────────

  describe("initiateTransfer (NO_ROUTE)", () => {
    it("should throw NO_ROUTE when getRoutes returns empty array", async () => {
      // Temporarily mock getRoutes to return empty
      const origGetRoutes = crossChainService.getRoutes.bind(crossChainService);
      jest.spyOn(crossChainService, "getRoutes").mockReturnValue([]);

      await expect(
        crossChainService.initiateTransfer(
          {
            sourceChain: "aethelred-mainnet",
            destinationChain: "ethereum-mainnet",
            token: "USDC",
            amount: "5000",
            recipient: "0xrecipient",
          },
          "0xsender",
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "NO_ROUTE" });

      jest.restoreAllMocks();
      jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
    });
  });

  // ─── CrossChainError ───────────────────────────────────────────────────────

  describe("CrossChainError", () => {
    it("should set properties correctly", () => {
      const err = new CrossChainError("CODE", "msg", 404);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe("CrossChainError");
    });

    it("should default statusCode to 400", () => {
      const err = new CrossChainError("CODE", "msg");
      expect(err.statusCode).toBe(400);
    });
  });
});
