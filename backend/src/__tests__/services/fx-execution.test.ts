/**
 * Tests for FX hedge open/close verification.
 *
 * Beyond the usual refusal matrix, two things here carry real weight:
 *
 * 1. The five ways a position can close are not interchangeable, and three of
 *    the five events do not name the hedger. PositionLiquidated names a
 *    LIQUIDATOR, who is by construction someone else — so the ownership check
 *    has to come from the position for that one, and a test proves the real
 *    owner is still accepted while a stranger is not.
 *
 * 2. pnl is int256. A loss is negative, and treating it as unsigned turns a
 *    loss into an enormous gain.
 */

const mockGetCanonicalTransaction = jest.fn();
const mockAssertCanonicalChainSnapshot = jest.fn();
const mockCall = jest.fn();

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
  return {
    ...actual,
    JsonRpcProvider: jest.fn(() => ({ call: (...a: unknown[]) => mockCall(...a) })),
  };
});

import { FX_INTERFACE } from "../../services/fx-chain";
import {
  FXExecutionError,
  FX_EVENT_INTERFACE,
  verifyHedgeClose,
  verifyHedgeOpen,
} from "../../services/fx-execution";

const VAULT = "0x5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c";
const OTHER = "0x000000000000000000000000000000000000dead";
const HEDGER = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";
const STRANGER = "0x1111111111111111111111111111111111111111";
const LIQUIDATOR = "0x3333333333333333333333333333333333333333";
const PAIR_ID = `0x${"ab".repeat(32)}`;
const POSITION_ID = `0x${"7f".repeat(32)}`;
const TX_HASH =
  "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa";

const config = {
  rpcUrl: "http://rpc.invalid",
  minimumConfirmations: 3,
} as never;

const env = { FX_HEDGING_VAULT_ADDRESS: VAULT } as NodeJS.ProcessEnv;

const MATURITY = 1_800_000_000;

const log = (name: string, args: unknown[], address = VAULT) => {
  const encoded = FX_EVENT_INTERFACE.encodeEventLog(name, args);
  return { address, topics: encoded.topics, data: encoded.data };
};

const forwardLog = (over: { hedger?: string; positionId?: string } = {}) =>
  log("ForwardCreated", [
    over.positionId ?? POSITION_ID,
    over.hedger ?? HEDGER,
    PAIR_ID,
    1_000_000n,
    367_300_000n,
    MATURITY,
  ]);

const optionLog = (over: { hedgeType?: number; hedger?: string } = {}) =>
  log("OptionCreated", [
    POSITION_ID,
    over.hedger ?? HEDGER,
    PAIR_ID,
    over.hedgeType ?? 1, // OPTION_CALL
    1_000_000n,
    367_300_000n,
    25_000n,
  ]);

const canonical = (logs: unknown[], to: string = VAULT) => ({
  receipt: { blockNumber: 5150, blockHash: "0xblock", logs },
  transaction: { to, from: HEDGER, data: "0x" },
  block: { timestamp: 1_700_000_000 },
  confirmations: 7,
});

/** getPosition returning a struct with the given hedger/type/status. */
const chainPosition = (
  over: { hedger?: string; hedgeType?: number; status?: number } = {},
) =>
  FX_INTERFACE.encodeFunctionResult("getPosition", [
    [
      POSITION_ID,
      over.hedger ?? HEDGER,
      PAIR_ID,
      over.hedgeType ?? 0, // FORWARD
      over.status ?? 0, // ACTIVE
      1_000_000n,
      367_300_000n,
      0n,
      "0x0000000000000000000000000000000000000000",
      500_000n,
      1_700_000_000n,
      BigInt(MATURITY),
      0n,
      0n,
      0n,
      0n,
    ],
  ]);

const ZERO_POSITION = chainPosition({
  hedger: "0x0000000000000000000000000000000000000000",
});

const openInput = {
  txHash: TX_HASH,
  onChainPositionId: POSITION_ID,
  expectedHedger: HEDGER,
  expectedHedgeType: "FORWARD" as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCanonicalTransaction.mockResolvedValue(canonical([forwardLog()]));
  mockAssertCanonicalChainSnapshot.mockResolvedValue(undefined);
  mockCall.mockResolvedValue(chainPosition());
});

describe("verifyHedgeOpen", () => {
  it("returns the position details worth recording", async () => {
    const result = await verifyHedgeOpen(config, openInput, env);
    expect(result.onChainPositionId).toBe(POSITION_ID.toLowerCase());
    expect(result.hedgeType).toBe("FORWARD");
    expect(result.notionalAmount).toBe("1000000");
    expect(result.rate).toBe("367300000");
    expect(result.maturityDate?.getTime()).toBe(MATURITY * 1000);
    expect(result.blockNumber).toBe(5150);
  });

  it("refuses a SWAP outright — the vault cannot create one", async () => {
    await expect(
      verifyHedgeOpen(
        config,
        { ...openInput, expectedHedgeType: "SWAP" as never },
        env,
      ),
    ).rejects.toMatchObject({ reason: "FX_UNSUPPORTED_HEDGE_TYPE" });
    // Refused before any RPC work.
    expect(mockGetCanonicalTransaction).not.toHaveBeenCalled();
  });

  it("refuses when no vault is configured", async () => {
    await expect(
      verifyHedgeOpen(config, openInput, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ reason: "NO_VAULT_CONFIGURED", statusCode: 501 });
  });

  it("treats an unmined transaction as 409", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("NOT_MINED"),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_NOT_MINED",
      statusCode: 409,
    });
  });

  it("refuses a reverted transaction", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("REVERTED"),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_REVERTED",
    });
  });

  it("reports an unreachable node as 503", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("RPC_UNAVAILABLE"),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_RPC_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("refuses a receipt from a different network", async () => {
    mockAssertCanonicalChainSnapshot.mockRejectedValue(new Error("anchor"));
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_CHAIN_MISMATCH",
    });
  });

  it("refuses a transaction sent to some other contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([forwardLog()], OTHER),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_WRONG_TARGET",
    });
  });

  it("ignores an event emitted by a different contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("ForwardCreated", [POSITION_ID, HEDGER, PAIR_ID, 1n, 1n, MATURITY], OTHER)]),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_EVENT_MISSING",
    });
  });

  it("refuses an event for a DIFFERENT position", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([forwardLog({ positionId: `0x${"11".repeat(32)}` })]),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_EVENT_MISSING",
    });
  });

  it("refuses a position opened by a different account", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([forwardLog({ hedger: STRANGER })]),
    );
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_HEDGER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses a PUT reported as a CALL — they are opposite bets", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([optionLog({ hedgeType: 2 })]), // OPTION_PUT
    );
    mockCall.mockResolvedValue(chainPosition({ hedgeType: 2 }));
    await expect(
      verifyHedgeOpen(
        config,
        { ...openInput, expectedHedgeType: "OPTION_CALL" },
        env,
      ),
    ).rejects.toMatchObject({ reason: "FX_TYPE_MISMATCH" });
  });

  it("accepts a CALL that matches", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([optionLog()]));
    mockCall.mockResolvedValue(chainPosition({ hedgeType: 1 }));
    const result = await verifyHedgeOpen(
      config,
      { ...openInput, expectedHedgeType: "OPTION_CALL" },
      env,
    );
    expect(result.hedgeType).toBe("OPTION_CALL");
    expect(result.premium).toBe("25000");
  });

  it("catches a direction mismatch from the EVENT alone", async () => {
    // Deliberately arranged so ONLY the event check can fire: the event says
    // PUT, the caller claims CALL, and the vault is made to agree with the
    // caller. Without the event-level check this passes, which is how a put
    // gets recorded as a call.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([optionLog({ hedgeType: 2 })]), // event: OPTION_PUT
    );
    mockCall.mockResolvedValue(chainPosition({ hedgeType: 1 })); // vault: CALL
    await expect(
      verifyHedgeOpen(
        config,
        { ...openInput, expectedHedgeType: "OPTION_CALL" },
        env,
      ),
    ).rejects.toMatchObject({ reason: "FX_TYPE_MISMATCH" });
  });

  it("refuses when the vault disagrees with the event about the type", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([optionLog()]));
    mockCall.mockResolvedValue(chainPosition({ hedgeType: 2 })); // vault says PUT
    await expect(
      verifyHedgeOpen(
        config,
        { ...openInput, expectedHedgeType: "OPTION_CALL" },
        env,
      ),
    ).rejects.toMatchObject({ reason: "FX_TYPE_MISMATCH" });
  });

  it("refuses when the vault has no such position", async () => {
    mockCall.mockResolvedValue(ZERO_POSITION);
    await expect(verifyHedgeOpen(config, openInput, env)).rejects.toMatchObject({
      reason: "FX_POSITION_UNKNOWN",
    });
  });
});

describe("verifyHedgeClose — the chain decides how it closed", () => {
  const closeInput = {
    txHash: TX_HASH,
    onChainPositionId: POSITION_ID,
    expectedHedger: HEDGER,
  };

  it("reports a settlement, with its signed P&L", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("PositionSettled", [POSITION_ID, HEDGER, 990_000n, 12_500n])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 2 })); // SETTLED
    const result = await verifyHedgeClose(config, closeInput, env);
    expect(result.closeKind).toBe("SETTLED");
    expect(result.chainStatus).toBe("SETTLED");
    expect(result.pnl).toBe("12500");
  });

  it("keeps a LOSS negative", async () => {
    // int256. Read as unsigned this becomes ~1.16e77 — a catastrophic gain
    // where there was a loss.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("PositionSettled", [POSITION_ID, HEDGER, 900_000n, -45_000n])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 2 }));
    const result = await verifyHedgeClose(config, closeInput, env);
    expect(result.pnl).toBe("-45000");
    expect(BigInt(result.pnl as string)).toBeLessThan(0n);
  });

  it("reports an exercise", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("OptionExercised", [POSITION_ID, HEDGER, 370_000_000n, 980_000n])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 3 })); // EXERCISED
    const result = await verifyHedgeClose(config, closeInput, env);
    expect(result.closeKind).toBe("EXERCISED");
    expect(result.settlementAmount).toBe("980000");
    expect(result.pnl).toBeNull();
  });

  it("reports an expiry, whose event names nobody at all", async () => {
    // OptionExpired carries only a position id, so ownership can only come
    // from the vault.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("OptionExpired", [POSITION_ID])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 4 })); // EXPIRED
    const result = await verifyHedgeClose(config, closeInput, env);
    expect(result.closeKind).toBe("EXPIRED");
    expect(result.hedger.toLowerCase()).toBe(HEDGER.toLowerCase());
  });

  it("reports a LIQUIDATION to its owner, not to the liquidator", async () => {
    // The event's only address is the liquidator. Binding the caller to it
    // would admit a stranger AND reject the real owner, so ownership comes
    // from the vault.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log("PositionLiquidated", [POSITION_ID, LIQUIDATOR, 500_000n, 25_000n]),
      ]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 5 })); // LIQUIDATED

    const result = await verifyHedgeClose(config, closeInput, env);
    expect(result.closeKind).toBe("LIQUIDATED");
    expect(result.chainStatus).toBe("LIQUIDATED");
    expect(result.hedger.toLowerCase()).toBe(HEDGER.toLowerCase());
  });

  it("refuses to let the LIQUIDATOR claim the position as theirs", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log("PositionLiquidated", [POSITION_ID, LIQUIDATOR, 500_000n, 25_000n]),
      ]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 5 }));

    await expect(
      verifyHedgeClose(config, { ...closeInput, expectedHedger: LIQUIDATOR }, env),
    ).rejects.toMatchObject({ reason: "FX_HEDGER_MISMATCH", statusCode: 403 });
  });

  it("reports an emergency unwind", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("EmergencyUnwind", [POSITION_ID, 750_000n, 1_700_000_000n])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 6 })); // EMERGENCY_UNWOUND
    const result = await verifyHedgeClose(config, closeInput, env);
    expect(result.closeKind).toBe("EMERGENCY_UNWOUND");
    expect(result.chainStatus).toBe("EMERGENCY_UNWOUND");
  });

  it("refuses when the vault's status contradicts the event", async () => {
    // A PositionSettled log while the vault still reports ACTIVE means the
    // read and the log disagree; neither is safe to record.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("PositionSettled", [POSITION_ID, HEDGER, 1n, 0n])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 0 })); // ACTIVE
    await expect(verifyHedgeClose(config, closeInput, env)).rejects.toMatchObject({
      reason: "FX_STATUS_NOT_TERMINAL",
    });
  });

  it("refuses a close event for a DIFFERENT position", async () => {
    // A real settlement of position B is not evidence about position A.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log("PositionSettled", [`0x${"22".repeat(32)}`, HEDGER, 1n, 0n]),
      ]),
    );
    await expect(verifyHedgeClose(config, closeInput, env)).rejects.toMatchObject({
      reason: "FX_EVENT_MISSING",
    });
  });

  it("refuses a settlement belonging to someone else", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("PositionSettled", [POSITION_ID, STRANGER, 1n, 0n])]),
    );
    mockCall.mockResolvedValue(chainPosition({ status: 2 }));
    await expect(verifyHedgeClose(config, closeInput, env)).rejects.toMatchObject({
      reason: "FX_HEDGER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses when the vault has no such position", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("OptionExpired", [POSITION_ID])]),
    );
    mockCall.mockResolvedValue(ZERO_POSITION);
    await expect(verifyHedgeClose(config, closeInput, env)).rejects.toMatchObject({
      reason: "FX_POSITION_UNKNOWN",
    });
  });
});

describe("FXExecutionError", () => {
  it("defaults to 422", () => {
    expect(new FXExecutionError("FX_REVERTED", "x").statusCode).toBe(422);
  });
});
