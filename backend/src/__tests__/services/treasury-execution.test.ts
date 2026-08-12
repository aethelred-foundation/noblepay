/**
 * Tests for on-chain treasury execution verification.
 *
 * The property under test is refusal. A caller can claim any transaction
 * settled any proposal; what matters is that each way of being wrong is caught
 * and named. Six checks must hold, and there is a test for failing each one —
 * because a verifier that only passes valid input is indistinguishable from a
 * function that returns true.
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

const TREASURY = "0xf87ea237cca6f4c932f13983f7df05c0b842b128";
jest.mock("../../services/treasury-chain", () => ({
  resolveTreasuryAddress: (env: NodeJS.ProcessEnv = {}) =>
    env.MULTISIG_TREASURY_ADDRESS === "" ? null : TREASURY,
}));

import { Interface } from "ethers";

import {
  TreasuryExecutionError,
  verifyTreasuryExecution,
} from "../../services/treasury-execution";

const IFACE = new Interface([
  "function executeProposal(bytes32 _proposalId)",
  "function getProposal(bytes32 _proposalId) view returns (tuple(bytes32 proposalId,address proposer,address recipient,address token,uint256 amount,uint8 category,string description,uint8 tier,uint8 status,uint256 approvalCount,uint256 rejectionCount,uint256 requiredApprovals,uint256 createdAt,uint256 timelockExpiry,uint256 expiresAt,bool isEmergency,bytes32 budgetId))",
  "event ProposalExecuted(bytes32 indexed proposalId,address indexed executor,uint256 amount,uint256 timestamp)",
]);

const PROPOSAL_ID =
  "0xb0e5549ef29f19213987c37c736b4955892f71e833ef1379f5306e02a77ebe6e";
const TX_HASH =
  "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa";
const EXECUTOR = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";

const config = {
  rpcUrl: "http://rpc.invalid",
  minimumConfirmations: 3,
} as never;

const executedLog = (proposalId = PROPOSAL_ID) => {
  const encoded = IFACE.encodeEventLog("ProposalExecuted", [
    proposalId,
    EXECUTOR,
    50_000n,
    1_700_000_000n,
  ]);
  return { address: TREASURY, topics: encoded.topics, data: encoded.data };
};

const canonical = (over: Record<string, unknown> = {}) => ({
  receipt: {
    blockNumber: 4242,
    blockHash: "0xblock",
    logs: [executedLog()],
    ...(over.receipt as object),
  },
  transaction: {
    to: TREASURY,
    from: EXECUTOR,
    data: IFACE.encodeFunctionData("executeProposal", [PROPOSAL_ID]),
    ...(over.transaction as object),
  },
  block: { timestamp: 1_700_000_000 },
  confirmations: 5,
});

/** getProposal returning the given status enum value. */
const proposalStatus = (status: number) =>
  IFACE.encodeFunctionResult("getProposal", [
    [
      PROPOSAL_ID,
      EXECUTOR,
      EXECUTOR,
      "0x0000000000000000000000000000000000000000",
      50_000n,
      0,
      "",
      1,
      status,
      2n,
      0n,
      2n,
      0n,
      0n,
      0n,
      false,
      `0x${"0".repeat(64)}`,
    ],
  ]);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCanonicalTransaction.mockResolvedValue(canonical());
  mockAssertCanonicalChainSnapshot.mockResolvedValue(undefined);
  mockCall.mockResolvedValue(proposalStatus(2)); // EXECUTED
});

const input = { txHash: TX_HASH, onChainProposalId: PROPOSAL_ID };

describe("verifyTreasuryExecution — the happy path", () => {
  it("returns the receipt details worth recording", async () => {
    const result = await verifyTreasuryExecution(config, input);
    expect(result.onChainProposalId).toBe(PROPOSAL_ID.toLowerCase());
    expect(result.txHash).toBe(TX_HASH.toLowerCase());
    expect(result.blockNumber).toBe(4242);
    expect(result.confirmations).toBe(5);
    expect(result.amount).toBe("50000");
  });

  it("reports the on-chain executor from the event, not the caller", async () => {
    // The account that submitted the transaction is a fact about the chain;
    // it need not be whoever called this API, and a reviewer needs both.
    const result = await verifyTreasuryExecution(config, input);
    expect(result.executor.toLowerCase()).toBe(EXECUTOR.toLowerCase());
  });

  it("enforces the configured confirmation depth", async () => {
    await verifyTreasuryExecution(config, input);
    expect(mockGetCanonicalTransaction).toHaveBeenCalledWith(
      expect.anything(),
      TX_HASH,
      3,
    );
  });
});

describe("verifyTreasuryExecution — each way of being wrong", () => {
  it("refuses when no treasury is configured", async () => {
    await expect(
      verifyTreasuryExecution(config, input, {
        MULTISIG_TREASURY_ADDRESS: "",
      } as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ reason: "NO_TREASURY_CONFIGURED", statusCode: 501 });
  });

  it("treats an unmined transaction as 409, not a permanent failure", async () => {
    // The caller should retry this one; it is not a lie, just early.
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("NOT_MINED"),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_NOT_MINED",
      statusCode: 409,
    });
  });

  it("refuses a reverted transaction", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("REVERTED"),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_REVERTED",
    });
  });

  it("refuses below the confirmation depth", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("INSUFFICIENT_CONFIRMATIONS"),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_NOT_CONFIRMED",
      statusCode: 409,
    });
  });

  it("reports an unreachable node as 503 rather than a verification failure", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("RPC_UNAVAILABLE"),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_RPC_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("refuses a receipt from a different network", async () => {
    mockAssertCanonicalChainSnapshot.mockRejectedValue(new Error("anchor"));
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_CHAIN_MISMATCH",
    });
  });

  it("refuses a transaction sent to some other contract", async () => {
    // A successful transaction elsewhere proves nothing about this proposal.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical({ transaction: { to: "0x000000000000000000000000000000000000dead" } }),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_WRONG_TARGET",
    });
  });

  it("refuses calldata that is not executeProposal", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical({ transaction: { data: "0xdeadbeef" } }),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_CALLDATA_MISMATCH",
    });
  });

  it("refuses when the transaction executed a DIFFERENT proposal", async () => {
    // The heart of it: a real, canonical, successful execution of proposal B
    // must not be accepted as evidence for proposal A.
    const other = `0x${"a".repeat(64)}`;
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical({
        transaction: {
          data: IFACE.encodeFunctionData("executeProposal", [other]),
        },
      }),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_CALLDATA_MISMATCH",
    });
  });

  it("refuses when ProposalExecuted was not emitted", async () => {
    // Calldata shows intent; the event shows the contract agreed.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical({ receipt: { blockNumber: 4242, blockHash: "0xblock", logs: [] } }),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_EVENT_MISSING",
    });
  });

  it("ignores a ProposalExecuted emitted by a different contract", async () => {
    // An impostor contract can emit any event it likes.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical({
        receipt: {
          blockNumber: 4242,
          blockHash: "0xblock",
          logs: [{ ...executedLog(), address: "0x000000000000000000000000000000000000dead" }],
        },
      }),
    );
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_EVENT_MISSING",
    });
  });

  it("refuses when the contract does not report the proposal as executed", async () => {
    // Historical event plus current state, both required: disagreement means
    // the read is pointed somewhere unexpected.
    mockCall.mockResolvedValue(proposalStatus(1)); // APPROVED
    await expect(verifyTreasuryExecution(config, input)).rejects.toMatchObject({
      reason: "EXECUTION_STATUS_NOT_EXECUTED",
    });
  });
});

describe("TreasuryExecutionError", () => {
  it("defaults to 422 — a claim that failed verification is not a server fault", () => {
    const error = new TreasuryExecutionError("EXECUTION_REVERTED", "x");
    expect(error.statusCode).toBe(422);
  });
});
