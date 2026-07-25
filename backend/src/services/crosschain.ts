import {
  Prisma,
  PrismaClient,
  type CrossChainTransfer as StoredTransfer,
  type RelayNode as StoredRelayNode,
} from "@prisma/client";
import { JsonRpcProvider } from "ethers";
import { AuditService } from "./audit";

export type TransferStatus =
  | "INITIATED"
  | "RELAYING"
  | "CONFIRMING"
  | "COMPLETED"
  | "FAILED"
  | "STUCK"
  | "RECOVERED";

interface ConfiguredChain {
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
}

export interface ChainInfo extends ConfiguredChain {
  status: "ONLINE" | "OFFLINE";
  currentGasPrice: string | null;
  gasPriceUnit: "wei";
  bridgeLiquidity: null;
  verifiedAt: Date;
}

export interface CrossChainTransferInput {
  sourceChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  recipient: string;
  metadata?: Record<string, unknown>;
}

export interface TransferStep {
  step: number;
  name: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  txHash: string | null;
  timestamp: Date | null;
  details: string;
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
  bridgeFee: string | null;
  gasEstimate: null;
  estimatedTime: number | null;
  relayNode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
  dataSource: "DATABASE_LEDGER";
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
  uptime: null;
  successRate: number;
  relayedCount: number;
  avgLatency: number;
  status: "ACTIVE" | "INACTIVE";
  registeredAt: Date;
  dataSource: "DATABASE_REGISTRY";
}

export interface CrossChainAnalytics {
  totalTransfers: number;
  totalVolume: string;
  avgSettlementTime: number | null;
  successRate: number | null;
  activeRelayNodes: number;
  topCorridors: Array<{
    source: string;
    destination: string;
    volume: string;
    count: number;
  }>;
  byChain: Record<
    string,
    { inbound: string; outbound: string; transfers: number }
  >;
  stuckTransfers: number;
  dataSource: "DATABASE_LEDGER";
}

type ChainProbe = (
  chain: ConfiguredChain,
) => Promise<{ chainId: number; gasPrice: bigint | null }>;

function objectMetadata(
  value: Prisma.JsonValue | null,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validSteps(value: unknown): TransferStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    if (
      !Number.isInteger(row.step) ||
      typeof row.name !== "string" ||
      !["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"].includes(
        String(row.status),
      )
    ) {
      return [];
    }
    const timestamp = row.timestamp ? new Date(String(row.timestamp)) : null;
    return [
      {
        step: Number(row.step),
        name: row.name,
        status: row.status as TransferStep["status"],
        txHash: typeof row.txHash === "string" ? row.txHash : null,
        timestamp:
          timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : null,
        details: typeof row.details === "string" ? row.details : "",
      },
    ];
  });
}

function transferRecord(
  transfer: StoredTransfer,
  businessId: string,
): CrossChainTransfer {
  const metadata = objectMetadata(transfer.metadata);
  return {
    id: transfer.id,
    businessId,
    sourceChain: transfer.sourceChain,
    destinationChain: transfer.destChain,
    token: transfer.currency,
    amount: transfer.amount.toString(),
    sender: transfer.sender,
    recipient: transfer.recipient,
    status: transfer.status,
    steps: validSteps(metadata.steps),
    sourceTxHash: transfer.sourceTxHash,
    destinationTxHash: transfer.destTxHash,
    bridgeFee: transfer.bridgeFee?.toString() ?? null,
    gasEstimate: null,
    estimatedTime: transfer.estimatedTime,
    relayNode: transfer.relayNode,
    createdAt: transfer.initiatedAt,
    completedAt: transfer.completedAt,
    metadata,
    dataSource: "DATABASE_LEDGER",
  };
}

function relayRecord(node: StoredRelayNode): RelayNode {
  return {
    id: node.id,
    address: node.address,
    chains: node.chains,
    stake: node.stake.toString(),
    uptime: null,
    successRate: node.successRate.toNumber(),
    relayedCount: node.totalRelayed,
    avgLatency: node.avgLatency,
    status: node.isActive ? "ACTIVE" : "INACTIVE",
    registeredAt: node.registeredAt,
    dataSource: "DATABASE_REGISTRY",
  };
}

/** Verified chain health plus durable, tenant-scoped bridge history. */
export class CrossChainService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly _auditService: AuditService,
    private readonly chainProbe: ChainProbe = async (chain) => {
      const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, {
        staticNetwork: true,
      });
      const [network, feeData] = await Promise.all([
        provider.getNetwork(),
        provider.getFeeData(),
      ]);
      return {
        chainId: Number(network.chainId),
        gasPrice: feeData.gasPrice,
      };
    },
  ) {}

  async getChains(): Promise<ChainInfo[]> {
    const configured = this.configuredChains();
    const checkedAt = new Date();
    return Promise.all(
      configured.map(async (chain) => {
        try {
          const probe = await this.chainProbe(chain);
          if (probe.chainId !== chain.chainId) {
            throw new Error("RPC chain ID mismatch");
          }
          return {
            ...chain,
            status: "ONLINE" as const,
            currentGasPrice: probe.gasPrice?.toString() ?? null,
            gasPriceUnit: "wei" as const,
            bridgeLiquidity: null,
            verifiedAt: checkedAt,
          };
        } catch {
          return {
            ...chain,
            status: "OFFLINE" as const,
            currentGasPrice: null,
            gasPriceUnit: "wei" as const,
            bridgeLiquidity: null,
            verifiedAt: checkedAt,
          };
        }
      }),
    );
  }

  async getRoutes(
    sourceChain: string,
    destinationChain: string,
    token: string,
    amount: string,
  ): Promise<never> {
    const amountNumber = Number(amount);
    if (!sourceChain || !destinationChain || sourceChain === destinationChain) {
      throw new CrossChainError(
        "INVALID_ROUTE",
        "Select two different configured chains",
      );
    }
    if (!token || !Number.isFinite(amountNumber) || amountNumber <= 0) {
      throw new CrossChainError(
        "INVALID_QUOTE_REQUEST",
        "A token and positive transfer amount are required",
      );
    }
    const chains = await this.getChains();
    const source = chains.find((chain) => chain.id === sourceChain);
    const destination = chains.find((chain) => chain.id === destinationChain);
    if (!source || !destination) {
      throw new CrossChainError(
        "CHAIN_NOT_FOUND",
        "Source or destination chain is not configured",
        404,
      );
    }
    if (source.status !== "ONLINE" || destination.status !== "ONLINE") {
      throw new CrossChainError(
        "CHAIN_RPC_UNAVAILABLE",
        "A source or destination RPC endpoint failed verification",
        503,
      );
    }
    throw new CrossChainError(
      "ROUTE_QUOTE_UNAVAILABLE",
      "Cross-chain quotes are disabled until a signed bridge quote provider is configured",
      503,
    );
  }

  async initiateTransfer(
    _input: CrossChainTransferInput,
    _sender: string,
    _businessId: string,
  ): Promise<never> {
    throw new CrossChainError(
      "BRIDGE_EXECUTION_UNAVAILABLE",
      "Cross-chain transfers are disabled until source and destination receipts can be verified",
      501,
    );
  }

  async getTransfer(
    transferId: string,
    businessId: string,
  ): Promise<CrossChainTransfer> {
    const wallet = await this.businessWallet(businessId);
    const transfer = await this.prisma.crossChainTransfer.findFirst({
      where: {
        id: transferId,
        sender: { equals: wallet, mode: "insensitive" },
      },
    });
    if (!transfer) {
      throw new CrossChainError(
        "TRANSFER_NOT_FOUND",
        "Transfer not found",
        404,
      );
    }
    return transferRecord(transfer, businessId);
  }

  async listTransfers(filters: {
    sender?: string;
    status?: TransferStatus;
    sourceChain?: string;
    destinationChain?: string;
    businessId: string;
    page?: number;
    limit?: number;
  }): Promise<CrossChainTransfer[]> {
    const wallet = await this.businessWallet(filters.businessId);
    if (
      filters.sender &&
      filters.sender.toLowerCase() !== wallet.toLowerCase()
    ) {
      throw new CrossChainError(
        "FORBIDDEN",
        "Transfers can only be read for the authenticated wallet",
        403,
      );
    }
    const transfers = await this.prisma.crossChainTransfer.findMany({
      where: {
        sender: { equals: wallet, mode: "insensitive" },
        status: filters.status,
        sourceChain: filters.sourceChain,
        destChain: filters.destinationChain,
      },
      orderBy: { initiatedAt: "desc" },
      skip:
        filters.page && filters.limit
          ? (filters.page - 1) * filters.limit
          : undefined,
      take: filters.limit,
    });
    return transfers.map((transfer) =>
      transferRecord(transfer, filters.businessId),
    );
  }

  async recoverTransfer(
    _transferId: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw new CrossChainError(
      "RECOVERY_EXECUTION_UNAVAILABLE",
      "Transfer recovery is disabled until bridge recovery receipts can be verified",
      501,
    );
  }

  async getRelayNodes(pagination?: {
    page: number;
    limit: number;
  }): Promise<RelayNode[]> {
    const nodes = await this.prisma.relayNode.findMany({
      orderBy: [{ isActive: "desc" }, { registeredAt: "asc" }],
      skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
      take: pagination?.limit,
    });
    return nodes.map(relayRecord);
  }

  async getAnalytics(businessId: string): Promise<CrossChainAnalytics> {
    const [transfers, activeRelayNodes] = await Promise.all([
      this.listTransfers({ businessId }),
      this.prisma.relayNode.count({ where: { isActive: true } }),
    ]);
    let totalVolume = new Prisma.Decimal(0);
    let settlementSeconds = 0;
    let completed = 0;
    const corridors: Record<string, { volume: Prisma.Decimal; count: number }> =
      {};
    const chains: Record<
      string,
      { inbound: Prisma.Decimal; outbound: Prisma.Decimal; transfers: number }
    > = {};

    for (const transfer of transfers) {
      const amount = new Prisma.Decimal(transfer.amount);
      totalVolume = totalVolume.add(amount);
      if (transfer.status === "COMPLETED" && transfer.completedAt) {
        settlementSeconds +=
          (transfer.completedAt.getTime() - transfer.createdAt.getTime()) /
          1000;
        completed += 1;
      }
      const corridorKey = `${transfer.sourceChain}\u0000${transfer.destinationChain}`;
      const corridor = corridors[corridorKey] ?? {
        volume: new Prisma.Decimal(0),
        count: 0,
      };
      corridor.volume = corridor.volume.add(amount);
      corridor.count += 1;
      corridors[corridorKey] = corridor;

      const source = chains[transfer.sourceChain] ?? {
        inbound: new Prisma.Decimal(0),
        outbound: new Prisma.Decimal(0),
        transfers: 0,
      };
      source.outbound = source.outbound.add(amount);
      source.transfers += 1;
      chains[transfer.sourceChain] = source;
      const destination = chains[transfer.destinationChain] ?? {
        inbound: new Prisma.Decimal(0),
        outbound: new Prisma.Decimal(0),
        transfers: 0,
      };
      destination.inbound = destination.inbound.add(amount);
      destination.transfers += 1;
      chains[transfer.destinationChain] = destination;
    }

    return {
      totalTransfers: transfers.length,
      totalVolume: totalVolume.toString(),
      avgSettlementTime: completed ? settlementSeconds / completed : null,
      successRate: transfers.length ? completed / transfers.length : null,
      activeRelayNodes,
      topCorridors: Object.entries(corridors)
        .map(([key, value]) => {
          const [source, destination] = key.split("\u0000");
          return {
            source,
            destination,
            volume: value.volume.toString(),
            count: value.count,
          };
        })
        .sort((left, right) => Number(right.volume) - Number(left.volume))
        .slice(0, 5),
      byChain: Object.fromEntries(
        Object.entries(chains).map(([chain, value]) => [
          chain,
          {
            inbound: value.inbound.toString(),
            outbound: value.outbound.toString(),
            transfers: value.transfers,
          },
        ]),
      ),
      stuckTransfers: transfers.filter(
        (transfer) => transfer.status === "STUCK",
      ).length,
      dataSource: "DATABASE_LEDGER",
    };
  }

  private configuredChains(): ConfiguredChain[] {
    const raw = process.env.CROSSCHAIN_CHAINS_JSON;
    if (!raw) {
      throw new CrossChainError(
        "CHAIN_REGISTRY_UNAVAILABLE",
        "Cross-chain health is unavailable because CROSSCHAIN_CHAINS_JSON is not configured",
        503,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CrossChainError(
        "CHAIN_REGISTRY_MISCONFIGURED",
        "CROSSCHAIN_CHAINS_JSON is invalid JSON",
        503,
      );
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new CrossChainError(
        "CHAIN_REGISTRY_MISCONFIGURED",
        "CROSSCHAIN_CHAINS_JSON must contain at least one chain",
        503,
      );
    }
    const ids = new Set<string>();
    return parsed.map((candidate) => {
      const row = candidate as Partial<ConfiguredChain>;
      const valid =
        row &&
        typeof row.id === "string" &&
        !ids.has(row.id) &&
        Number.isInteger(row.chainId) &&
        Number(row.chainId) > 0 &&
        typeof row.name === "string" &&
        ["EVM", "COSMOS", "L2"].includes(String(row.type)) &&
        typeof row.rpcUrl === "string" &&
        typeof row.explorer === "string" &&
        Number(row.avgBlockTime) > 0 &&
        Number(row.finality) > 0 &&
        typeof row.nativeToken === "string" &&
        Array.isArray(row.supportedTokens);
      if (!valid) {
        throw new CrossChainError(
          "CHAIN_REGISTRY_MISCONFIGURED",
          "CROSSCHAIN_CHAINS_JSON contains an invalid chain",
          503,
        );
      }
      let rpc: URL;
      let explorer: URL;
      try {
        rpc = new URL(row.rpcUrl as string);
        explorer = new URL(row.explorer as string);
      } catch {
        throw new CrossChainError(
          "CHAIN_REGISTRY_MISCONFIGURED",
          "Configured chain URLs are invalid",
          503,
        );
      }
      if (
        process.env.NODE_ENV === "production" &&
        (rpc.protocol !== "https:" || explorer.protocol !== "https:")
      ) {
        throw new CrossChainError(
          "CHAIN_REGISTRY_MISCONFIGURED",
          "Production chain RPC and explorer URLs must use HTTPS",
          503,
        );
      }
      ids.add(row.id as string);
      return row as ConfiguredChain;
    });
  }

  private async businessWallet(businessId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { address: true },
    });
    if (!business) {
      throw new CrossChainError(
        "BUSINESS_NOT_FOUND",
        "Authenticated business was not found",
        404,
      );
    }
    return business.address;
  }
}

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
