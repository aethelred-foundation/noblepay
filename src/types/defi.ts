// ============================================================
// NoblePay DeFi Type Definitions
// Types for liquidity pools, payment streams, and FX hedging
// ============================================================

// ---------------------------------------------------------------------------
// Liquidity Pool Types
// ---------------------------------------------------------------------------

/** Liquidity pool status */
export type PoolStatus = 'Active' | 'Paused' | 'Deprecated';

/** A liquidity pool for payment settlement */
export interface LiquidityPool {
  /** Pool contract address */
  address: string;
  /** Pool name (e.g. 'USDC/AET') */
  name: string;
  /** Token A symbol */
  tokenA: string;
  /** Token B symbol */
  tokenB: string;
  /** Total value locked in USD */
  tvl: number;
  /** 24-hour trading volume (USD) */
  volume24h: number;
  /** Current APY for liquidity providers */
  apy: number;
  /** Fee tier in basis points (e.g. 30 = 0.30%) */
  feeBps: number;
  /** Pool status */
  status: PoolStatus;
  /** Token A reserve amount */
  reserveA: number;
  /** Token B reserve amount */
  reserveB: number;
  /** Number of active LP positions */
  lpCount: number;
  /** Pool creation timestamp (Unix ms) */
  createdAt: number;
}

/** A user's LP position in a pool */
export interface LPPosition {
  /** Position identifier */
  id: string;
  /** Pool address this position belongs to */
  poolAddress: string;
  /** Pool name for display */
  poolName: string;
  /** Liquidity token balance (LP tokens) */
  lpTokens: number;
  /** Share of pool as percentage (0-100) */
  poolShare: number;
  /** Current value of position (USD) */
  valueUsd: number;
  /** Unclaimed fees earned (USD) */
  unclaimedFees: number;
  /** Impermanent loss percentage */
  impermanentLoss: number;
  /** Position opened timestamp (Unix ms) */
  enteredAt: number;
}

// ---------------------------------------------------------------------------
// Payment Stream Types
// ---------------------------------------------------------------------------

/** Payment stream status */
export type StreamStatus = 'Active' | 'Paused' | 'Completed' | 'Cancelled';

/** A continuous payment stream (salary, subscription, etc.) */
export interface PaymentStream {
  /** Stream identifier (bytes32) */
  id: string;
  /** Sender wallet address */
  sender: string;
  /** Recipient wallet address */
  recipient: string;
  /** Token symbol */
  tokenSymbol: string;
  /** Total deposited amount */
  totalAmount: number;
  /** Amount streamed so far */
  streamedAmount: number;
  /** Flow rate per second (token units) */
  ratePerSecond: number;
  /** Stream start timestamp (Unix ms) */
  startTime: number;
  /** Stream end timestamp (Unix ms) */
  endTime: number;
  /** Stream status */
  status: StreamStatus;
  /** Whether the stream is cancelable */
  cancelable: boolean;
  /** Last withdrawal timestamp (Unix ms) */
  lastWithdrawal: number;
}

/** Real-time stream balance snapshot */
export interface StreamBalance {
  /** Stream identifier */
  streamId: string;
  /** Withdrawable balance (already streamed, not yet claimed) */
  withdrawable: number;
  /** Remaining balance (not yet streamed) */
  remaining: number;
  /** Total deposited */
  deposited: number;
  /** Total withdrawn */
  withdrawn: number;
  /** Timestamp of this snapshot (Unix ms) */
  snapshotAt: number;
}

// ---------------------------------------------------------------------------
// FX Hedging Types
// ---------------------------------------------------------------------------

/** FX hedge status */
export type HedgeStatus = 'Active' | 'Settled' | 'Expired' | 'Liquidated';

/** An FX hedging position for cross-border rate protection */
export interface FXHedge {
  /** Hedge identifier */
  id: string;
  /** Source currency (e.g. 'USD') */
  fromCurrency: string;
  /** Target currency (e.g. 'AED') */
  toCurrency: string;
  /** Notional amount in source currency */
  notionalAmount: number;
  /** Locked exchange rate */
  lockedRate: number;
  /** Current market rate */
  currentRate: number;
  /** Unrealized PnL (USD) */
  unrealizedPnl: number;
  /** Hedge status */
  status: HedgeStatus;
  /** Expiry timestamp (Unix ms) */
  expiryAt: number;
  /** Creation timestamp (Unix ms) */
  createdAt: number;
  /** Collateral deposited (USD) */
  collateral: number;
}

/** Real-time FX rate data */
export interface FXRate {
  /** Currency pair (e.g. 'USD/AED') */
  pair: string;
  /** Current mid rate */
  rate: number;
  /** 24h change percentage */
  change24h: number;
  /** Bid price */
  bid: number;
  /** Ask price */
  ask: number;
  /** Last updated timestamp (Unix ms) */
  updatedAt: number;
}

/** FX exposure report across all corridors */
export interface ExposureReport {
  /** Total notional exposure (USD) */
  totalExposure: number;
  /** Hedged percentage (0-100) */
  hedgedPercentage: number;
  /** Unhedged exposure (USD) */
  unhedgedExposure: number;
  /** Exposure breakdown by currency pair */
  byPair: {
    pair: string;
    exposure: number;
    hedged: number;
    unhedged: number;
  }[];
  /** Value at Risk (95% confidence, USD) */
  valueAtRisk: number;
  /** Report generation timestamp (Unix ms) */
  generatedAt: number;
}
