import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { logger, maskIdentifier } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type TransferStatus = "INITIATED" | "LOCKED" | "RELAYED" | "CONFIRMED" | "COMPLETED" | "FAILED" | "STUCK" | "RECOVERED";

export interface ChainInfo {
  id: string;
  chainId: number;
  name: string;
  type: "EVM" | "COSMOS" | "L2";
  rpcUrl: string;
  explorer: string;
  avgBlockTime: number;
  finality: number;
  nativeToken: string;
  supportedTokens: string[];
  status: "ONLINE" | "DEGRADED" | "OFFLINE";
  currentGasPrice: string;
  bridgeLiquidity: Record<string, string>;
}

export interface CrossChainTransferInput {
  sourceChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  recipient: string;
  metadata?: Record<string, unknown>;
}

export interface CrossChainTransfer {
  id: string;
  businessId: string;
  sourceChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  sender: string;
  recipient: string;
  status: TransferStatus;
  steps: TransferStep[];
  sourceTxHash: string | null;
  destinationTxHash: string | null;
  bridgeFee: string;
  gasEstimate: string;
  estimatedTime: number;
  createdAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface TransferStep {
  step: number;
  name: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  txHash: string | null;
  timestamp: Date | null;
  details: string;
}

export interface RouteOption {
  path: string[];
  estimatedFee: string;
  estimatedTime: number;
  hops: number;
  reliability: number;
  gasEstimate: string;
}

export interface RelayNode {
  id: string;
  address: string;
  chains: string[];
  stake: string;
  uptime: number;
  relayedCount: number;
  avgLatency: number;
  status: "ACTIVE" | "INACTIVE" | "SLASHED";
}

export interface CrossChainAnalytics {
  totalTransfers: number;
  totalVolume: string;
  avgSettlementTime: number;
  successRate: number;
  activeRelayNodes: number;
  topCorridors: Array<{ source: string; destination: string; volume: string; count: number }>;
  byChain: Record<string, { inbound: string; outbound: string; transfers: number }>;
  stuckTransfers: number;
}

// ─── Supported Chains ───────────────────────────────────────────────────────

const SUPPORTED_CHAINS: ChainInfo[] = [
  {
    id: "aethelred-mainnet", chainId: 7331, name: "Aethelred L1", type: "EVM",
    rpcUrl: "https://rpc.aethelred.network", explorer: "https://explorer.aethelred.network",
    avgBlockTime: 2, finality: 12, nativeToken: "AET",
    supportedTokens: ["AET", "USDC", "USDT", "AED"], status: "ONLINE",
    currentGasPrice: "5", bridgeLiquidity: { AET: "10000000", USDC: "5000000", USDT: "3000000" },
  },
  {
    id: "ethereum-mainnet", chainId: 1, name: "Ethereum", type: "EVM",
    rpcUrl: "https://eth.llamarpc.com", explorer: "https://etherscan.io",
    avgBlockTime: 12, finality: 64, nativeToken: "ETH",
    supportedTokens: ["ETH", "USDC", "USDT", "DAI"], status: "ONLINE",
    currentGasPrice: "25", bridgeLiquidity: { USDC: "20000000", USDT: "15000000" },
  },
  {
    id: "polygon-mainnet", chainId: 137, name: "Polygon", type: "L2",
    rpcUrl: "https://polygon-rpc.com", explorer: "https://polygonscan.com",
    avgBlockTime: 2, finality: 128, nativeToken: "MATIC",
    supportedTokens: ["MATIC", "USDC", "USDT"], status: "ONLINE",
    currentGasPrice: "30", bridgeLiquidity: { USDC: "8000000", USDT: "6000000" },
  },
  {
    id: "arbitrum-one", chainId: 42161, name: "Arbitrum One", type: "L2",
    rpcUrl: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io",
    avgBlockTime: 0.25, finality: 1, nativeToken: "ETH",
    supportedTokens: ["ETH", "USDC", "USDT", "ARB"], status: "ONLINE",
    currentGasPrice: "0.1", bridgeLiquidity: { USDC: "12000000", USDT: "9000000" },
  },
  {
    id: "base-mainnet", chainId: 8453, name: "Base", type: "L2",
    rpcUrl: "https://mainnet.base.org", explorer: "https://basescan.org",
    avgBlockTime: 2, finality: 1, nativeToken: "ETH",
    supportedTokens: ["ETH", "USDC", "USDT"], status: "ONLINE",
    currentGasPrice: "0.05", bridgeLiquidity: { USDC: "6000000", USDT: "4000000" },
  },
];

// ─── Service ────────────────────────────────────────────────────────────────

export class CrossChainService {
  private transfers: Map<string, CrossChainTransfer> = new Map();
  private relayNodes: RelayNode[] = [];

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {
    this.initializeRelayNodes();
  }

  private initializeRelayNodes(): void {
    this.relayNodes = [
      { id: "relay-001", address: "0x1a2b3c4d5e6f7890abcdef1234567890abcdef12", chains: ["aethelred-mainnet", "ethereum-mainnet", "polygon-mainnet"], stake: "500000", uptime: 99.8, relayedCount: 15420, avgLatency: 2.3, status: "ACTIVE" },
      { id: "relay-002", address: "0x2b3c4d5e6f7890abcdef1234567890abcdef1234", chains: ["aethelred-mainnet", "arbitrum-one", "base-mainnet"], stake: "350000", uptime: 99.5, relayedCount: 12890, avgLatency: 1.8, status: "ACTIVE" },
      { id: "relay-003", address: "0x3c4d5e6f7890abcdef1234567890abcdef123456", chains: ["ethereum-mainnet", "polygon-mainnet", "arbitrum-one"], stake: "420000", uptime: 98.9, relayedCount: 18300, avgLatency: 3.1, status: "ACTIVE" },
      { id: "relay-004", address: "0x4d5e6f7890abcdef1234567890abcdef12345678", chains: ["aethelred-mainnet", "ethereum-mainnet", "arbitrum-one", "base-mainnet"], stake: "680000", uptime: 99.9, relayedCount: 22150, avgLatency: 1.5, status: "ACTIVE" },
    ];
  }

  /**
   * Get all supported chains with health status.
   */
  getChains(): ChainInfo[] {
    return SUPPORTED_CHAINS;
  }

  /**
   * Get optimal routes between two chains.
   */
  getRoutes(sourceChain: string, destChain: string, token: string, amount: string): RouteOption[] {
    const source = SUPPORTED_CHAINS.find((c) => c.id === sourceChain);
    const dest = SUPPORTED_CHAINS.find((c) => c.id === destChain);

    if (!source || !dest) {
      throw new CrossChainError("CHAIN_NOT_FOUND", "Source or destination chain not supported", 404);
    }

    const amountNum = parseFloat(amount);
    const routes: RouteOption[] = [];

    // Direct route
    routes.push({
      path: [sourceChain, destChain],
      estimatedFee: (amountNum * 0.001).toFixed(2), // 10 bps
      estimatedTime: source.finality * source.avgBlockTime + dest.finality * dest.avgBlockTime,
      hops: 1,
      reliability: 0.995,
      gasEstimate: (parseFloat(source.currentGasPrice) * 250000 / 1e9).toFixed(6),
    });

    // Multi-hop via Aethelred (if not direct)
    if (sourceChain !== "aethelred-mainnet" && destChain !== "aethelred-mainnet") {
      routes.push({
        path: [sourceChain, "aethelred-mainnet", destChain],
        estimatedFee: (amountNum * 0.0015).toFixed(2), // 15 bps
        estimatedTime: source.finality * source.avgBlockTime + 24 + dest.finality * dest.avgBlockTime,
        hops: 2,
        reliability: 0.99,
        gasEstimate: (parseFloat(source.currentGasPrice) * 350000 / 1e9).toFixed(6),
      });
    }

    return routes.sort((a, b) => parseFloat(a.estimatedFee) - parseFloat(b.estimatedFee));
  }

  /**
   * Initiate a cross-chain transfer.
   */
  async initiateTransfer(
    input: CrossChainTransferInput,
    sender: string,
    businessId: string,
  ): Promise<CrossChainTransfer> {
    const routes = this.getRoutes(input.sourceChain, input.destinationChain, input.token, input.amount);
    if (routes.length === 0) {
      throw new CrossChainError("NO_ROUTE", "No available route between chains");
    }

    const bestRoute = routes[0];
    const transferId = "xc-" + crypto.randomBytes(8).toString("hex");

    const steps: TransferStep[] = [
      { step: 1, name: "Lock tokens on source chain", status: "IN_PROGRESS", txHash: null, timestamp: new Date(), details: `Locking ${input.amount} ${input.token} on ${input.sourceChain}` },
      { step: 2, name: "Relay message to destination", status: "PENDING", txHash: null, timestamp: null, details: "Relay nodes will propagate the cross-chain message" },
      { step: 3, name: "Verify proof on destination", status: "PENDING", txHash: null, timestamp: null, details: "Optimistic verification with fraud proof window" },
      { step: 4, name: "Release tokens on destination", status: "PENDING", txHash: null, timestamp: null, details: `Releasing ${input.amount} ${input.token} to ${input.recipient}` },
    ];

    const transfer: CrossChainTransfer = {
      id: transferId,
      businessId,
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      token: input.token,
      amount: input.amount,
      sender,
      recipient: input.recipient,
      status: "INITIATED",
      steps,
      sourceTxHash: "0x" + crypto.randomBytes(32).toString("hex"),
      destinationTxHash: null,
      bridgeFee: bestRoute.estimatedFee,
      gasEstimate: bestRoute.gasEstimate,
      estimatedTime: bestRoute.estimatedTime,
      createdAt: new Date(),
      completedAt: null,
      metadata: input.metadata || {},
    };

    this.transfers.set(transferId, transfer);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: sender,
      description: `Cross-chain transfer initiated: ${input.amount} ${input.token} from ${input.sourceChain} to ${input.destinationChain}`,
      severity: "MEDIUM",
      metadata: { transferId, route: bestRoute.path },
    });

    logger.info("Cross-chain transfer initiated", {
      transferId,
      sourceChain: input.sourceChain,
      destinationChain: input.destinationChain,
      amount: input.amount,
      token: input.token,
      estimatedTime: bestRoute.estimatedTime,
    });

    return transfer;
  }

  /**
   * Get transfer by ID.
   */
  getTransfer(transferId: string, businessId?: string): CrossChainTransfer {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new CrossChainError("TRANSFER_NOT_FOUND", "Transfer not found", 404);
    }
    if (businessId && transfer.businessId !== businessId) {
      throw new CrossChainError("FORBIDDEN", "You do not have permission to access this transfer", 403);
    }
    return transfer;
  }

  /**
   * List all transfers with filters.
   */
  listTransfers(filters?: {
    sender?: string;
    status?: TransferStatus;
    sourceChain?: string;
    destinationChain?: string;
    businessId?: string;
  }): CrossChainTransfer[] {
    let transfers = Array.from(this.transfers.values());

    if (filters?.businessId) transfers = transfers.filter((t) => t.businessId === filters.businessId);
    if (filters?.sender) transfers = transfers.filter((t) => t.sender === filters.sender);
    if (filters?.status) transfers = transfers.filter((t) => t.status === filters.status);
    if (filters?.sourceChain) transfers = transfers.filter((t) => t.sourceChain === filters.sourceChain);
    if (filters?.destinationChain) transfers = transfers.filter((t) => t.destinationChain === filters.destinationChain);

    return transfers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Attempt to recover a stuck transfer.
   */
  async recoverTransfer(
    transferId: string,
    actor: string,
    businessId?: string,
  ): Promise<{ success: boolean; message: string }> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) {
      throw new CrossChainError("TRANSFER_NOT_FOUND", "Transfer not found", 404);
    }
    if (businessId && transfer.businessId !== businessId) {
      throw new CrossChainError("FORBIDDEN", "You do not have permission to recover this transfer", 403);
    }

    if (transfer.status !== "STUCK" && transfer.status !== "FAILED") {
      throw new CrossChainError("INVALID_STATE", `Cannot recover transfer in ${transfer.status} state`, 409);
    }

    transfer.status = "RECOVERED";
    transfer.completedAt = new Date();
    this.transfers.set(transferId, transfer);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Cross-chain transfer ${transferId} recovered`,
      severity: "HIGH",
      metadata: { transferId },
    });

    logger.info("Transfer recovered", {
      transferRef: maskIdentifier(transferId),
      actorRef: maskIdentifier(actor),
    });
    return { success: true, message: "Transfer recovery initiated" };
  }

  /**
   * Get relay node list.
   */
  getRelayNodes(): RelayNode[] {
    return this.relayNodes;
  }

  /**
   * Get cross-chain analytics.
   */
  getAnalytics(businessId?: string): CrossChainAnalytics {
    let transfers = Array.from(this.transfers.values());
    if (businessId) {
      transfers = transfers.filter((t) => t.businessId === businessId);
    }

    let totalVolume = 0;
    let totalSettlementTime = 0;
    let completedCount = 0;

    const corridorMap: Map<string, { volume: number; count: number }> = new Map();
    const chainMap: Map<string, { inbound: number; outbound: number; transfers: number }> = new Map();

    for (const t of transfers) {
      totalVolume += parseFloat(t.amount);

      if (t.status === "COMPLETED" && t.completedAt) {
        totalSettlementTime += t.completedAt.getTime() - t.createdAt.getTime();
        completedCount++;
      }

      const corridorKey = `${t.sourceChain} → ${t.destinationChain}`;
      const existing = corridorMap.get(corridorKey) || { volume: 0, count: 0 };
      corridorMap.set(corridorKey, {
        volume: existing.volume + parseFloat(t.amount),
        count: existing.count + 1,
      });

      // Source chain outbound
      const sourceStats = chainMap.get(t.sourceChain) || { inbound: 0, outbound: 0, transfers: 0 };
      sourceStats.outbound += parseFloat(t.amount);
      sourceStats.transfers++;
      chainMap.set(t.sourceChain, sourceStats);

      // Dest chain inbound
      const destStats = chainMap.get(t.destinationChain) || { inbound: 0, outbound: 0, transfers: 0 };
      destStats.inbound += parseFloat(t.amount);
      chainMap.set(t.destinationChain, destStats);
    }

    const topCorridors = Array.from(corridorMap.entries())
      .map(([key, data]) => {
        const [source, destination] = key.split(" → ");
        return { source, destination, volume: data.volume.toFixed(2), count: data.count };
      })
      .sort((a, b) => parseFloat(b.volume) - parseFloat(a.volume))
      .slice(0, 5);

    const byChain: Record<string, { inbound: string; outbound: string; transfers: number }> = {};
    for (const [chain, data] of chainMap) {
      byChain[chain] = {
        inbound: data.inbound.toFixed(2),
        outbound: data.outbound.toFixed(2),
        transfers: data.transfers,
      };
    }

    return {
      totalTransfers: transfers.length,
      totalVolume: totalVolume.toFixed(2),
      avgSettlementTime: completedCount > 0 ? totalSettlementTime / completedCount / 1000 : 0,
      successRate: transfers.length > 0
        ? transfers.filter((t) => t.status === "COMPLETED").length / transfers.length
        : 1,
      activeRelayNodes: this.relayNodes.filter((n) => n.status === "ACTIVE").length,
      topCorridors,
      byChain,
      stuckTransfers: transfers.filter((t) => t.status === "STUCK").length,
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class CrossChainError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "CrossChainError";
  }
}
