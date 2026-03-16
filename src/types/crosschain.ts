// ============================================================
// NoblePay Cross-Chain Type Definitions
// Types for cross-chain transfers, routing, and relay nodes
// ============================================================

// ---------------------------------------------------------------------------
// Chain Types
// ---------------------------------------------------------------------------

/** Chain operational status */
export type ChainStatus = 'Online' | 'Degraded' | 'Offline' | 'Maintenance';

/** Supported chain information */
export interface ChainInfo {
  /** Chain ID */
  chainId: number;
  /** Chain name */
  name: string;
  /** Chain symbol (e.g. 'ETH', 'AETH') */
  symbol: string;
  /** RPC endpoint URL */
  rpcUrl: string;
  /** Block explorer URL */
  explorerUrl: string;
  /** Chain operational status */
  status: ChainStatus;
  /** Average block time in seconds */
  avgBlockTime: number;
  /** Current gas price (gwei) */
  gasPrice: number;
  /** NoblePay router contract address on this chain */
  routerAddress: string;
  /** Supported token addresses on this chain */
  supportedTokens: string[];
  /** Chain logo path */
  logoPath: string;
}

// ---------------------------------------------------------------------------
// Transfer Types
// ---------------------------------------------------------------------------

/** Cross-chain transfer status */
export type TransferStatus =
  | 'Initiated'
  | 'SourceConfirmed'
  | 'Relaying'
  | 'DestPending'
  | 'Completed'
  | 'Failed'
  | 'Refunded';

/** A single step in a cross-chain transfer */
export interface TransferStep {
  /** Step index (0-based) */
  index: number;
  /** Step description (e.g. 'Lock tokens on source chain') */
  description: string;
  /** Chain ID where this step executes */
  chainId: number;
  /** Step status */
  status: 'Pending' | 'InProgress' | 'Completed' | 'Failed';
  /** Transaction hash for this step, if available */
  txHash?: string;
  /** Timestamp when step started (Unix ms) */
  startedAt?: number;
  /** Timestamp when step completed (Unix ms) */
  completedAt?: number;
}

/** A cross-chain transfer record */
export interface CrossChainTransfer {
  /** Transfer identifier */
  id: string;
  /** Source chain ID */
  sourceChainId: number;
  /** Destination chain ID */
  destChainId: number;
  /** Source chain name */
  sourceChainName: string;
  /** Destination chain name */
  destChainName: string;
  /** Sender address */
  sender: string;
  /** Recipient address */
  recipient: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Transfer amount (human-readable) */
  amount: number;
  /** Transfer status */
  status: TransferStatus;
  /** Individual transfer steps */
  steps: TransferStep[];
  /** Estimated total time in seconds */
  estimatedTime: number;
  /** Bridge fee (USD) */
  bridgeFee: number;
  /** Relay node handling this transfer */
  relayNodeId: string;
  /** Transfer initiation timestamp (Unix ms) */
  initiatedAt: number;
  /** Transfer completion timestamp (Unix ms), 0 if not complete */
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Route Types
// ---------------------------------------------------------------------------

/** A routing option for a cross-chain transfer */
export interface RouteOption {
  /** Route identifier */
  id: string;
  /** Route name (e.g. 'Direct Bridge', 'Multi-Hop') */
  name: string;
  /** Ordered list of chain IDs in the route */
  path: number[];
  /** Estimated transfer time in seconds */
  estimatedTime: number;
  /** Total fee in USD */
  totalFeeUsd: number;
  /** Fee breakdown */
  fees: {
    bridgeFee: number;
    gasFee: number;
    relayFee: number;
  };
  /** Estimated slippage percentage */
  slippage: number;
  /** Whether this is the recommended route */
  recommended: boolean;
}

// ---------------------------------------------------------------------------
// Relay Node Types
// ---------------------------------------------------------------------------

/** Relay node operational status */
export type RelayNodeStatus = 'Active' | 'Syncing' | 'Offline' | 'Maintenance';

/** A cross-chain relay node */
export interface RelayNode {
  /** Node identifier */
  id: string;
  /** Node display name */
  name: string;
  /** Node operator address */
  operator: string;
  /** Chains supported by this node */
  supportedChains: number[];
  /** Node status */
  status: RelayNodeStatus;
  /** Total transfers relayed */
  totalRelayed: number;
  /** Success rate percentage (0-100) */
  successRate: number;
  /** Average relay time in seconds */
  avgRelayTime: number;
  /** Staked collateral (USD) */
  stakedCollateral: number;
  /** Uptime percentage (0-100) */
  uptime: number;
  /** Last active timestamp (Unix ms) */
  lastActiveAt: number;
}
