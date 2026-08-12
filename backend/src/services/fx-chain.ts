/**
 * On-chain reads for the FXHedgingVault.
 *
 * Sits alongside services/fx.ts the way treasury-chain sits alongside
 * services/treasury.ts: that module reports the database snapshot, this one
 * reports the vault. Results carry dataSource "CHAIN_FX_HEDGING_VAULT" so the
 * two are never conflated.
 *
 * The chain vocabulary is deliberately NOT mapped onto the database's. The DB
 * models HedgeType as FORWARD | OPTION | SWAP and HedgeStatus as
 * OPEN | CLOSED | EXPIRED | EXERCISED. The contract has three hedge types
 * (FORWARD, OPTION_CALL, OPTION_PUT — no swaps) and seven statuses, including
 * LIQUIDATED and EMERGENCY_UNWOUND, which have no database equivalent.
 * Squeezing the contract into the DB's four statuses would silently report a
 * liquidated position as merely "CLOSED", which is precisely the fact an
 * operator most needs to see. Chain enums are reported as the contract defines
 * them.
 *
 * Reads use ethers Interface + provider.call, matching compliance-chain.ts.
 */

import { Interface, JsonRpcProvider } from "ethers";

import type { NoblePayChainConfiguration } from "../lib/production-config";

/**
 * Fragments this service calls, pinned against the compiled artifact by
 * backend/src/__tests__/services/fx-chain.abi.test.ts. getPosition returns a
 * sixteen-field struct; a fragment that drifts decodes into the wrong fields
 * rather than failing, which is why the guard exists.
 */
export const FX_INTERFACE = new Interface([
  "function getActivePairs() view returns (bytes32[])",
  "function getCurrencyPair(bytes32 _pairId) view returns (tuple(bytes3 baseCurrency,bytes3 quoteCurrency,bytes32 pairId,bool active,uint256 maxHedgeRatio,uint256 marginRequirementBps,uint256 maintenanceMarginBps))",
  "function getLatestRate(bytes32 _pairId) view returns (uint256 rate,uint256 updatedAt)",
  "function getBusinessPositions(address _hedger) view returns (bytes32[])",
  "function getPosition(bytes32 _positionId) view returns (tuple(bytes32 positionId,address hedger,bytes32 pairId,uint8 hedgeType,uint8 status,uint256 notionalAmount,uint256 lockedRate,uint256 premium,address collateralToken,uint256 collateralAmount,uint256 createdAt,uint256 maturityDate,uint256 settledAt,uint256 settlementAmount,uint256 markToMarketValue,uint256 lastMtMUpdate))",
  "function getPortfolio(address _hedger) view returns (tuple(uint256 totalNotional,uint256 totalCollateral,uint256 totalPremiumPaid,uint256 totalPnL,uint256 unrealizedPnL,uint256 positionCount,uint256 lastRebalanced))",
  "function isUnderMargined(bytes32 _positionId) view returns (bool)",
  "function RATE_PRECISION() view returns (uint256)",
  "function settlementFeeBps() view returns (uint256)",
]);

/** Contract enum orderings. On-chain uint8 values; do not reorder. */
export const CHAIN_HEDGE_TYPE = [
  "FORWARD",
  "OPTION_CALL",
  "OPTION_PUT",
] as const;

export const CHAIN_POSITION_STATUS = [
  "ACTIVE",
  "MATURED",
  "SETTLED",
  "EXERCISED",
  "EXPIRED",
  "LIQUIDATED",
  "EMERGENCY_UNWOUND",
] as const;

export type ChainHedgeType = (typeof CHAIN_HEDGE_TYPE)[number];
export type ChainPositionStatus = (typeof CHAIN_POSITION_STATUS)[number];

const CHAIN_SOURCE = "CHAIN_FX_HEDGING_VAULT" as const;

export interface ChainCurrencyPair {
  pairId: string;
  /** Decoded from bytes3, e.g. "AED". */
  base: string;
  quote: string;
  active: boolean;
  maxHedgeRatioBps: number;
  marginRequirementBps: number;
  maintenanceMarginBps: number;
  /**
   * Latest oracle rate in RATE_PRECISION units, or null when the oracle has
   * never published for this pair. Null rather than "0": a pair awaiting its
   * first rate is not a pair trading at zero, and the contract's constructor
   * grants no ORACLE_ROLE, so an unpublished pair is the default state of a
   * fresh deployment rather than an anomaly.
   */
  rate: string | null;
  rateUpdatedAt: string | null;
}

export interface ChainHedgePosition {
  positionId: string;
  hedger: string;
  pairId: string;
  hedgeType: ChainHedgeType;
  status: ChainPositionStatus;
  notionalAmount: string;
  lockedRate: string;
  premium: string;
  collateralToken: string;
  collateralAmount: string;
  createdAt: string;
  maturityDate: string;
  settledAt: string;
  settlementAmount: string;
  markToMarketValue: string;
  lastMtMUpdate: string;
  /** Live maintenance-margin check, or null when it could not be evaluated. */
  underMargined: boolean | null;
}

export interface ChainPortfolio {
  totalNotional: string;
  totalCollateral: string;
  totalPremiumPaid: string;
  totalPnL: string;
  unrealizedPnL: string;
  positionCount: number;
  lastRebalanced: string;
}

export interface ChainFXAvailable {
  configured: true;
  address: string;
  /** Decimal places for rates and notionals, read from RATE_PRECISION. */
  rateDecimals: number;
  settlementFeeBps: number;
  pairs: ChainCurrencyPair[];
  dataSource: typeof CHAIN_SOURCE;
  readAtBlock: string;
}

export interface ChainFXUnavailable {
  configured: false;
  reason: "NO_FX_VAULT_ADDRESS_CONFIGURED";
  dataSource: typeof CHAIN_SOURCE;
}

export type ChainFXResult = ChainFXAvailable | ChainFXUnavailable;

const UNCONFIGURED: ChainFXUnavailable = {
  configured: false,
  reason: "NO_FX_VAULT_ADDRESS_CONFIGURED",
  dataSource: CHAIN_SOURCE,
};

/** Optional by design; the vault is not one of the core contracts. */
export function resolveFXVaultAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.FX_HEDGING_VAULT_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

/**
 * Decode a bytes3 currency code to ASCII. The contract stores "AED" as
 * 0x414544; trailing zero bytes are padding, not characters.
 */
export function decodeCurrency(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  let out = "";
  for (let i = 0; i + 1 < body.length; i += 2) {
    const code = Number.parseInt(body.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeCall<T>(fn: string, data: string): T {
  return FX_INTERFACE.decodeFunctionResult(fn, data) as unknown as T;
}

/** Number of decimal places implied by RATE_PRECISION (1e8 -> 8). */
function decimalsFromPrecision(precision: bigint): number {
  let d = 0;
  let v = precision;
  while (v > 1n) {
    v /= 10n;
    d += 1;
  }
  return d;
}

/**
 * Configured currency pairs and their latest oracle rates, read at one pinned
 * block so the set is mutually consistent.
 */
export async function readFXPairs(
  config: Pick<NoblePayChainConfiguration, "rpcUrl">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChainFXResult> {
  const address = resolveFXVaultAddress(env);
  if (!address) return UNCONFIGURED;

  const provider = new JsonRpcProvider(config.rpcUrl);
  const blockTag = await provider.getBlockNumber();

  const call = async (fn: string, args: unknown[] = []) =>
    provider.call({
      to: address,
      data: FX_INTERFACE.encodeFunctionData(fn, args),
      blockTag,
    });

  const [rawIds, rawPrecision, rawFee] = await Promise.all([
    call("getActivePairs"),
    call("RATE_PRECISION"),
    call("settlementFeeBps"),
  ]);

  const [ids] = decodeCall<[string[]]>("getActivePairs", rawIds);
  const [precision] = decodeCall<[bigint]>("RATE_PRECISION", rawPrecision);
  const [feeBps] = decodeCall<[bigint]>("settlementFeeBps", rawFee);

  const pairs = await Promise.all(
    ids.map(async (pairId) => {
      const rawPair = await call("getCurrencyPair", [pairId]);
      const [p] = decodeCall<
        [
          {
            baseCurrency: string;
            quoteCurrency: string;
            pairId: string;
            active: boolean;
            maxHedgeRatio: bigint;
            marginRequirementBps: bigint;
            maintenanceMarginBps: bigint;
          },
        ]
      >("getCurrencyPair", rawPair);

      // getLatestRate reverts when the oracle has never published, and on a
      // fresh vault that is every pair — the constructor grants no
      // ORACLE_ROLE. Treat it as "no rate yet", not as a failed read.
      let rate: string | null = null;
      let rateUpdatedAt: string | null = null;
      try {
        const rawRate = await call("getLatestRate", [pairId]);
        const [r, at] = decodeCall<[bigint, bigint]>("getLatestRate", rawRate);
        rate = r.toString();
        rateUpdatedAt = at.toString();
      } catch {
        /* no rate published for this pair */
      }

      return {
        pairId,
        base: decodeCurrency(p.baseCurrency),
        quote: decodeCurrency(p.quoteCurrency),
        active: p.active,
        maxHedgeRatioBps: Number(p.maxHedgeRatio),
        marginRequirementBps: Number(p.marginRequirementBps),
        maintenanceMarginBps: Number(p.maintenanceMarginBps),
        rate,
        rateUpdatedAt,
      } satisfies ChainCurrencyPair;
    }),
  );

  return {
    configured: true,
    address,
    rateDecimals: decimalsFromPrecision(precision),
    settlementFeeBps: Number(feeBps),
    pairs,
    dataSource: CHAIN_SOURCE,
    readAtBlock: blockTag.toString(),
  };
}

/**
 * A hedger's positions, with a live maintenance-margin check per position.
 *
 * Positions are enumerable via getBusinessPositions, so unlike the treasury's
 * proposals these need no event scraping.
 */
export async function readHedgerPositions(
  config: Pick<NoblePayChainConfiguration, "rpcUrl">,
  hedger: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  configured: boolean;
  positions: ChainHedgePosition[];
  portfolio: ChainPortfolio | null;
  dataSource: typeof CHAIN_SOURCE;
}> {
  const address = resolveFXVaultAddress(env);
  if (!address) {
    return {
      configured: false,
      positions: [],
      portfolio: null,
      dataSource: CHAIN_SOURCE,
    };
  }

  const provider = new JsonRpcProvider(config.rpcUrl);
  const blockTag = await provider.getBlockNumber();
  const call = async (fn: string, args: unknown[] = []) =>
    provider.call({
      to: address,
      data: FX_INTERFACE.encodeFunctionData(fn, args),
      blockTag,
    });

  const [rawIds, rawPortfolio] = await Promise.all([
    call("getBusinessPositions", [hedger]),
    call("getPortfolio", [hedger]),
  ]);
  const [ids] = decodeCall<[string[]]>("getBusinessPositions", rawIds);
  const [pf] = decodeCall<
    [
      {
        totalNotional: bigint;
        totalCollateral: bigint;
        totalPremiumPaid: bigint;
        totalPnL: bigint;
        unrealizedPnL: bigint;
        positionCount: bigint;
        lastRebalanced: bigint;
      },
    ]
  >("getPortfolio", rawPortfolio);

  const positions = await Promise.all(
    ids.map(async (positionId) => {
      const rawPos = await call("getPosition", [positionId]);
      const [p] = decodeCall<
        [
          {
            positionId: string;
            hedger: string;
            pairId: string;
            hedgeType: bigint;
            status: bigint;
            notionalAmount: bigint;
            lockedRate: bigint;
            premium: bigint;
            collateralToken: string;
            collateralAmount: bigint;
            createdAt: bigint;
            maturityDate: bigint;
            settledAt: bigint;
            settlementAmount: bigint;
            markToMarketValue: bigint;
            lastMtMUpdate: bigint;
          },
        ]
      >("getPosition", rawPos);

      // The margin check depends on a published rate, so it can revert for a
      // pair the oracle has not covered. Null distinguishes "could not be
      // evaluated" from "evaluated and found adequately margined" — reporting
      // the latter when we mean the former would understate risk.
      let underMargined: boolean | null = null;
      try {
        const rawMargin = await call("isUnderMargined", [positionId]);
        const [flag] = decodeCall<[boolean]>("isUnderMargined", rawMargin);
        underMargined = flag;
      } catch {
        /* not evaluable at this block */
      }

      return {
        positionId: p.positionId,
        hedger: p.hedger,
        pairId: p.pairId,
        hedgeType:
          CHAIN_HEDGE_TYPE[Number(p.hedgeType)] ?? ("UNKNOWN" as ChainHedgeType),
        status:
          CHAIN_POSITION_STATUS[Number(p.status)] ??
          ("UNKNOWN" as ChainPositionStatus),
        notionalAmount: p.notionalAmount.toString(),
        lockedRate: p.lockedRate.toString(),
        premium: p.premium.toString(),
        collateralToken: p.collateralToken,
        collateralAmount: p.collateralAmount.toString(),
        createdAt: p.createdAt.toString(),
        maturityDate: p.maturityDate.toString(),
        settledAt: p.settledAt.toString(),
        settlementAmount: p.settlementAmount.toString(),
        markToMarketValue: p.markToMarketValue.toString(),
        lastMtMUpdate: p.lastMtMUpdate.toString(),
        underMargined,
      } satisfies ChainHedgePosition;
    }),
  );

  return {
    configured: true,
    positions: positions.reverse(),
    portfolio: {
      totalNotional: pf.totalNotional.toString(),
      totalCollateral: pf.totalCollateral.toString(),
      totalPremiumPaid: pf.totalPremiumPaid.toString(),
      totalPnL: pf.totalPnL.toString(),
      unrealizedPnL: pf.unrealizedPnL.toString(),
      positionCount: Number(pf.positionCount),
      lastRebalanced: pf.lastRebalanced.toString(),
    },
    dataSource: CHAIN_SOURCE,
  };
}
