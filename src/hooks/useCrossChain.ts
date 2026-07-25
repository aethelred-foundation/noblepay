import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/api";
import type {
  ChainInfo,
  CrossChainTransfer,
  RelayNode,
  TransferStatus,
} from "@/types/crosschain";

interface ApiChain {
  id: string;
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  avgBlockTime: number;
  nativeToken: string;
  supportedTokens: string[];
  status: "ONLINE" | "OFFLINE";
  currentGasPrice: string | null;
}

interface ApiTransferStep {
  step: number;
  name: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  txHash: string | null;
  timestamp: string | null;
  details: string;
}

interface ApiTransfer {
  id: string;
  sourceChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  sender: string;
  recipient: string;
  status:
    | "INITIATED"
    | "RELAYING"
    | "CONFIRMING"
    | "COMPLETED"
    | "FAILED"
    | "STUCK"
    | "RECOVERED";
  steps: ApiTransferStep[];
  bridgeFee: string | null;
  estimatedTime: number | null;
  createdAt: string;
  completedAt: string | null;
}

interface ApiRelayNode {
  id: string;
  address: string;
  chains: string[];
  stake: string;
  uptime: null;
  successRate: number;
  relayedCount: number;
  avgLatency: number;
  status: "ACTIVE" | "INACTIVE" | "SLASHED";
}

function titleCaseStatus(value: ApiChain["status"]): ChainInfo["status"] {
  if (value === "ONLINE") return "Online";
  return "Offline";
}

function mapTransferStatus(value: ApiTransfer["status"]): TransferStatus {
  const statuses: Record<ApiTransfer["status"], TransferStatus> = {
    INITIATED: "Initiated",
    RELAYING: "Relaying",
    CONFIRMING: "DestPending",
    COMPLETED: "Completed",
    FAILED: "Failed",
    STUCK: "Failed",
    RECOVERED: "Refunded",
  };
  return statuses[value];
}

function mapChain(chain: ApiChain): ChainInfo {
  return {
    chainId: chain.chainId,
    name: chain.name,
    symbol: chain.nativeToken,
    rpcUrl: chain.rpcUrl,
    explorerUrl: chain.explorer,
    status: titleCaseStatus(chain.status),
    avgBlockTime: chain.avgBlockTime,
    gasPrice:
      chain.currentGasPrice === null ? null : Number(chain.currentGasPrice),
    routerAddress: "",
    supportedTokens: chain.supportedTokens,
    logoPath: "",
  };
}

function mapTransfer(
  transfer: ApiTransfer,
  chainById: Map<string, ApiChain>,
): CrossChainTransfer {
  const source = chainById.get(transfer.sourceChain);
  const destination = chainById.get(transfer.destinationChain);
  const sourceChainId = source?.chainId ?? (Number(transfer.sourceChain) || 0);
  const destinationChainId =
    destination?.chainId ?? (Number(transfer.destinationChain) || 0);

  return {
    id: transfer.id,
    sourceChainId,
    destChainId: destinationChainId,
    sourceChainName: source?.name || transfer.sourceChain,
    destChainName: destination?.name || transfer.destinationChain,
    sender: transfer.sender,
    recipient: transfer.recipient,
    tokenSymbol: transfer.token,
    amount: Number(transfer.amount),
    status: mapTransferStatus(transfer.status),
    steps: transfer.steps.map((step) => ({
      index: step.step,
      description: step.details || step.name,
      chainId: step.step === 0 ? sourceChainId : destinationChainId,
      status:
        step.status === "IN_PROGRESS"
          ? "InProgress"
          : step.status === "PENDING"
            ? "Pending"
            : step.status === "COMPLETED"
              ? "Completed"
              : "Failed",
      txHash: step.txHash || undefined,
      startedAt: step.timestamp ? Date.parse(step.timestamp) : undefined,
      completedAt:
        step.status === "COMPLETED" && step.timestamp
          ? Date.parse(step.timestamp)
          : undefined,
    })),
    estimatedTime: transfer.estimatedTime,
    bridgeFee: transfer.bridgeFee === null ? null : Number(transfer.bridgeFee),
    relayNodeId: "",
    initiatedAt: Date.parse(transfer.createdAt),
    completedAt: transfer.completedAt ? Date.parse(transfer.completedAt) : 0,
  };
}

function mapRelay(node: ApiRelayNode, chains: ApiChain[]): RelayNode {
  const chainIds = new Map(chains.map((chain) => [chain.id, chain.chainId]));
  return {
    id: node.id,
    name: node.id,
    operator: node.address,
    supportedChains: node.chains
      .map((chain) => chainIds.get(chain) ?? Number(chain))
      .filter((chain): chain is number => Number.isFinite(chain)),
    status: node.status === "ACTIVE" ? "Active" : "Offline",
    totalRelayed: node.relayedCount,
    successRate: node.successRate,
    avgRelayTime: node.avgLatency / 1000,
    stakedCollateral: Number(node.stake),
    uptime: node.uptime,
    lastActiveAt: null,
  };
}

export function useCrossChain() {
  const chainsQuery = useQuery({
    queryKey: ["crosschain", "chains"],
    queryFn: ({ signal }) =>
      apiRequest<ApiChain[]>("/v1/crosschain/chains", { signal }),
  });
  const transfersQuery = useQuery({
    queryKey: ["crosschain", "transfers"],
    queryFn: ({ signal }) =>
      apiRequest<ApiTransfer[]>("/v1/crosschain/transfers", { signal }),
  });
  const relaysQuery = useQuery({
    queryKey: ["crosschain", "relays"],
    queryFn: ({ signal }) =>
      apiRequest<ApiRelayNode[]>("/v1/crosschain/relays", { signal }),
  });

  const chainById = useMemo(
    () => new Map((chainsQuery.data || []).map((chain) => [chain.id, chain])),
    [chainsQuery.data],
  );
  const chains = useMemo(
    () => (chainsQuery.data || []).map(mapChain),
    [chainsQuery.data],
  );
  const transfers = useMemo(
    () =>
      (transfersQuery.data || []).map((transfer) =>
        mapTransfer(transfer, chainById),
      ),
    [chainById, transfersQuery.data],
  );
  const relayNodes = useMemo(
    () =>
      (relaysQuery.data || []).map((node) =>
        mapRelay(node, chainsQuery.data || []),
      ),
    [chainsQuery.data, relaysQuery.data],
  );

  const getRouteOptions = useCallback(
    (
      _sourceChainId: number,
      _destChainId: number,
      _amount: number,
      _tokenSymbol?: string,
    ) =>
      Promise.reject(
        new ApiError(
          "Route discovery is disabled until a signed bridge quote provider is configured.",
          { status: 503, code: "ROUTE_QUOTE_UNAVAILABLE" },
        ),
      ),
    [],
  );

  const initiateTransfer = useCallback(
    (_params: {
      sourceChainId: number;
      destChainId: number;
      recipient: string;
      tokenSymbol: string;
      amount: number;
      routeId: string;
    }) =>
      Promise.reject(
        new ApiError(
          "Cross-chain transfers are disabled until both chain receipts can be verified.",
          { status: 501, code: "BRIDGE_EXECUTION_UNAVAILABLE" },
        ),
      ),
    [],
  );

  const refetch = useCallback(async () => {
    await Promise.all([
      chainsQuery.refetch(),
      transfersQuery.refetch(),
      relaysQuery.refetch(),
    ]);
  }, [chainsQuery, relaysQuery, transfersQuery]);

  const error = transfersQuery.error || relaysQuery.error || null;

  return {
    chains,
    transfers,
    relayNodes,
    isLoading: transfersQuery.isLoading || relaysQuery.isLoading,
    chainsLoading: chainsQuery.isLoading,
    isMutating: false,
    error,
    chainsError: chainsQuery.error || null,
    mutationsEnabled: false,
    mutationReason:
      "Bridge quotes and execution are disabled until signed quotes and both-chain receipts can be verified.",
    refetch,
    getRouteOptions,
    initiateTransfer,
  };
}
