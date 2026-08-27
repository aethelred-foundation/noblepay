/**
 * Tests for liquidity settlement verification.
 *
 * Two properties matter here beyond the usual canonical-transaction checks.
 *
 * Provider binding: the event's provider is compared against the caller, so one
 * account cannot report another's settlement and attach the position to itself.
 *
 * Flash atomicity: a flash loan must be borrowed and repaid inside ONE
 * transaction. A receipt containing only FlashLoanInitiated describes value
 * that left the pool unsecured — the exact condition the contract exists to
 * prevent — so it must be refused rather than recorded.
 *
 * The declared event fragments are also pinned against the compiled artifact:
 * LiquidityAdded carries seven fields including two int24 ticks, and a drifted
 * fragment would decode into the wrong ones rather than fail.
 */

const mockGetCanonicalTransaction = jest.fn();
const mockAssertCanonicalChainSnapshot = jest.fn();

class MockCanonicalTransactionError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

jest.mock("../../lib/canonical-chain-transaction", () => ({
  getCanonicalTransaction: (...a: unknown[]) => mockGetCanonicalTransaction(...a),
  assertCanonicalChainSnapshot: (...a: unknown[]) =>
    mockAssertCanonicalChainSnapshot(...a),
  CanonicalTransactionError: MockCanonicalTransactionError,
}));

jest.mock("ethers", () => {
  const actual = jest.requireActual("ethers");
  return { ...actual, JsonRpcProvider: jest.fn(() => ({})) };
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Fragment, Interface } from "ethers";

import {
  LIQUIDITY_INTERFACE,
  LiquiditySettlementError,
  resolveLiquidityPoolAddress,
  verifyFlashLoan,
  verifyLiquiditySettlement,
} from "../../services/liquidity-execution";

const POOL = "0xeb63d671653489b91e653c52a018b63d5095223b";
const PROVIDER = "0x1111111111111111111111111111111111111111";
const POSITION_ID = `0x${"b".repeat(64)}`;
const POOL_ID = `0x${"c".repeat(64)}`;
const LOAN_ID = `0x${"d".repeat(64)}`;
const TX_HASH = `0x${"e".repeat(64)}`;

const env = { LIQUIDITY_POOL_ADDRESS: POOL } as NodeJS.ProcessEnv;
const config = {
  rpcUrl: "http://rpc.invalid",
  minimumConfirmations: 3,
} as never;

const log = (name: string, args: unknown[]) => {
  const encoded = LIQUIDITY_INTERFACE.encodeEventLog(name, args);
  return { address: POOL, topics: encoded.topics, data: encoded.data };
};

const addedLog = (positionId = POSITION_ID, provider = PROVIDER) =>
  log("LiquidityAdded", [positionId, POOL_ID, provider, 1000n, 2000n, -100, 100]);

const removedLog = (positionId = POSITION_ID, provider = PROVIDER) =>
  log("LiquidityRemoved", [positionId, POOL_ID, provider, 500n, 900n]);

const initiatedLog = (loanId = LOAN_ID, borrower = PROVIDER) =>
  log("FlashLoanInitiated", [
    loanId,
    POOL_ID,
    borrower,
    "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
    10_000n,
    30n,
  ]);

const repaidLog = (loanId = LOAN_ID, borrower = PROVIDER) =>
  log("FlashLoanRepaid", [loanId, borrower]);

const canonical = (logs: unknown[], to = POOL) => ({
  receipt: { blockNumber: 8080, blockHash: "0xblock", logs },
  transaction: { to, from: PROVIDER, data: "0x" },
  block: { timestamp: 1_700_000_000 },
  confirmations: 5,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertCanonicalChainSnapshot.mockResolvedValue(undefined);
});

describe("resolveLiquidityPoolAddress", () => {
  it("is optional, like the treasury address", () => {
    expect(resolveLiquidityPoolAddress({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("rejects the zero address", () => {
    expect(
      resolveLiquidityPoolAddress({
        LIQUIDITY_POOL_ADDRESS: `0x${"0".repeat(40)}`,
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("verifyLiquiditySettlement", () => {
  const input = {
    txHash: TX_HASH,
    onChainPositionId: POSITION_ID,
    kind: "ADD" as const,
    expectedProvider: PROVIDER,
  };

  it("accepts a canonical add with a matching position and provider", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([addedLog()]));
    const result = await verifyLiquiditySettlement(config, input, env);
    expect(result.onChainPositionId).toBe(POSITION_ID.toLowerCase());
    expect(result.amountToken0).toBe("1000");
    expect(result.amountToken1).toBe("2000");
    expect(result.blockNumber).toBe(8080);
  });

  it("verifies a remove against LiquidityRemoved, not LiquidityAdded", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([removedLog()]));
    const result = await verifyLiquiditySettlement(
      config,
      { ...input, kind: "REMOVE" },
      env,
    );
    expect(result.amountToken0).toBe("500");
  });

  it("refuses an add whose receipt only contains a remove", async () => {
    // Both are canonical pool events; only one is evidence for this claim.
    mockGetCanonicalTransaction.mockResolvedValue(canonical([removedLog()]));
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_EVENT_MISSING" });
  });

  it("refuses a settlement for a different position", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([addedLog(`0x${"9".repeat(64)}`)]),
    );
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_EVENT_MISSING" });
  });

  it("refuses to credit one account for another's settlement", async () => {
    // The provider is read from the event, not from the request body.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([addedLog(POSITION_ID, "0x2222222222222222222222222222222222222222")]),
    );
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({
      reason: "SETTLEMENT_PROVIDER_MISMATCH",
      statusCode: 403,
    });
  });

  it("ignores an event emitted by a contract that is not the pool", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([{ ...addedLog(), address: "0x000000000000000000000000000000000000dead" }]),
    );
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_EVENT_MISSING" });
  });

  it("refuses a transaction sent to another contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([addedLog()], "0x000000000000000000000000000000000000dead"),
    );
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_WRONG_TARGET" });
  });

  it("refuses when no pool is configured", async () => {
    await expect(
      verifyLiquiditySettlement(config, input, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ reason: "NO_POOL_CONFIGURED", statusCode: 501 });
  });

  it("treats an unmined transaction as retryable", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("NOT_MINED"),
    );
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_NOT_MINED", statusCode: 409 });
  });

  it("refuses a reverted settlement", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("REVERTED"),
    );
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_REVERTED" });
  });

  it("refuses a receipt from a different network", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([addedLog()]));
    mockAssertCanonicalChainSnapshot.mockRejectedValue(new Error("anchor"));
    await expect(
      verifyLiquiditySettlement(config, input, env),
    ).rejects.toMatchObject({ reason: "SETTLEMENT_CHAIN_MISMATCH" });
  });
});

describe("verifyFlashLoan — atomicity", () => {
  const input = {
    txHash: TX_HASH,
    flashLoanId: LOAN_ID,
    expectedBorrower: PROVIDER,
  };

  it("accepts a loan borrowed and repaid in one transaction", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog(), repaidLog()]),
    );
    const result = await verifyFlashLoan(config, input, env);
    expect(result.flashLoanId).toBe(LOAN_ID.toLowerCase());
    expect(result.amount).toBe("10000");
    expect(result.fee).toBe("30");
  });

  it("REFUSES a loan initiated without repayment in the same transaction", async () => {
    // The whole safety property. A borrow whose repayment is not in this
    // receipt describes value that left the pool unsecured; recording it as a
    // completed flash loan would document a loss as a success.
    mockGetCanonicalTransaction.mockResolvedValue(canonical([initiatedLog()]));
    await expect(verifyFlashLoan(config, input, env)).rejects.toMatchObject({
      reason: "FLASH_LOAN_NOT_REPAID",
    });
  });

  it("refuses when the repayment belongs to a DIFFERENT loan", async () => {
    // A repayment in the same transaction is not enough; it must be this loan.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog(), repaidLog(`0x${"7".repeat(64)}`)]),
    );
    await expect(verifyFlashLoan(config, input, env)).rejects.toMatchObject({
      reason: "FLASH_LOAN_NOT_REPAID",
    });
  });

  it("refuses when only a repayment is present", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([repaidLog()]));
    await expect(verifyFlashLoan(config, input, env)).rejects.toMatchObject({
      reason: "SETTLEMENT_EVENT_MISSING",
    });
  });

  it("refuses to credit a different borrower", async () => {
    const other = "0x2222222222222222222222222222222222222222";
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog(LOAN_ID, other), repaidLog(LOAN_ID, other)]),
    );
    await expect(verifyFlashLoan(config, input, env)).rejects.toMatchObject({
      reason: "SETTLEMENT_PROVIDER_MISMATCH",
      statusCode: 403,
    });
  });
});

// ---------------------------------------------------------------------------

const ARTIFACT = join(
  process.cwd(),
  "..",
  "contracts",
  "artifacts",
  "src",
  "LiquidityPool.sol",
  "LiquidityPool.json",
);

if (!existsSync(ARTIFACT)) {
  throw new Error(
    `LiquidityPool artifact not found at ${ARTIFACT}.\n` +
      `Compile the contracts before running backend tests:\n` +
      `  (cd contracts && npx hardhat compile)`,
  );
}

describe("LIQUIDITY_INTERFACE drift", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    abi: unknown[];
  };
  const compiled = new Interface(artifact.abi as never);
  const declared = LIQUIDITY_INTERFACE.fragments.filter(
    (f): f is Fragment => f.type === "event",
  );

  it.each(declared.map((f) => [f.format("sighash"), f] as const))(
    "%s matches the compiled contract",
    (_sig, fragment) => {
      const match = compiled.fragments.find(
        (c) =>
          c.type === fragment.type &&
          c.format("sighash") === fragment.format("sighash"),
      );
      expect(match).toBeDefined();
      expect(match?.format("full")).toBe(fragment.format("full"));
    },
  );
});

describe("LiquiditySettlementError", () => {
  it("defaults to 422 — a failed claim is not a server fault", () => {
    expect(new LiquiditySettlementError("SETTLEMENT_REVERTED", "x").statusCode).toBe(
      422,
    );
  });
});
