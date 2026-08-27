import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../../lib/canonical-chain-transaction";

const TX_HASH = `0x${"11".repeat(32)}`;
const OTHER_TX_HASH = `0x${"22".repeat(32)}`;
const BLOCK_HASH = `0x${"33".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"44".repeat(32)}`;

function fixture() {
  const receipt: any = {
    hash: TX_HASH,
    status: 1,
    blockNumber: 42,
    blockHash: BLOCK_HASH,
    confirmations: jest.fn().mockResolvedValue(3),
  };
  const transaction: any = {
    hash: TX_HASH,
    blockNumber: 42,
    blockHash: BLOCK_HASH,
  };
  const block: any = {
    number: 42,
    hash: BLOCK_HASH,
    timestamp: 1_750_000_000,
  };
  const provider: any = {
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue(transaction),
    getBlock: jest.fn().mockResolvedValue(block),
  };
  return { provider, receipt, transaction, block };
}

async function expectReason(
  current: ReturnType<typeof fixture>,
  reason: CanonicalTransactionError["reason"],
) {
  await expect(
    getCanonicalTransaction(current.provider, TX_HASH, 2),
  ).rejects.toMatchObject({ reason });
}

describe("getCanonicalTransaction", () => {
  it("re-fetches after confirmation and returns only mutually consistent canonical evidence", async () => {
    const current = fixture();
    await expect(
      getCanonicalTransaction(current.provider, TX_HASH.toUpperCase(), 2),
    ).resolves.toEqual({
      receipt: current.receipt,
      transaction: current.transaction,
      block: current.block,
      confirmations: 3,
    });
    expect(current.provider.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(current.receipt.confirmations).toHaveBeenCalledTimes(2);
    expect(current.provider.getTransaction).toHaveBeenCalledTimes(1);
    expect(current.provider.getBlock).toHaveBeenCalledWith(42);
  });

  it("does not read transaction or canonical block before the required depth", async () => {
    const current = fixture();
    current.receipt.confirmations.mockResolvedValueOnce(1);
    await expectReason(current, "INSUFFICIENT_CONFIRMATIONS");
    expect(current.provider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(current.provider.getTransaction).not.toHaveBeenCalled();
    expect(current.provider.getBlock).not.toHaveBeenCalled();
  });

  it("fails closed if the re-fetched receipt loses confirmation depth", async () => {
    const current = fixture();
    current.receipt.confirmations
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    await expectReason(current, "INSUFFICIENT_CONFIRMATIONS");
    expect(current.provider.getBlock).not.toHaveBeenCalled();
  });

  it("rejects a substituted receipt returned by the post-confirmation re-fetch", async () => {
    const current = fixture();
    current.provider.getTransactionReceipt
      .mockResolvedValueOnce(current.receipt)
      .mockResolvedValueOnce({
        ...current.receipt,
        hash: OTHER_TX_HASH,
      });
    await expectReason(current, "HASH_MISMATCH");
    expect(current.provider.getBlock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing initial receipt",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransactionReceipt.mockResolvedValueOnce(null),
      "NOT_MINED",
    ],
    [
      "missing canonical receipt",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransactionReceipt
          .mockResolvedValueOnce(f.receipt)
          .mockResolvedValueOnce(null),
      "NOT_MINED",
    ],
    [
      "missing transaction",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransaction.mockResolvedValue(null),
      "NOT_MINED",
    ],
    [
      "wrong receipt hash",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.hash = OTHER_TX_HASH;
      },
      "HASH_MISMATCH",
    ],
    [
      "wrong transaction hash",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.hash = OTHER_TX_HASH;
      },
      "HASH_MISMATCH",
    ],
    [
      "reverted receipt",
      (f: ReturnType<typeof fixture>) => {
        f.receipt.status = 0;
      },
      "REVERTED",
    ],
    [
      "receipt/transaction block-number mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.blockNumber = 41;
      },
      "CANONICAL_MISMATCH",
    ],
    [
      "receipt/transaction block-hash mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.blockHash = OTHER_BLOCK_HASH;
      },
      "CANONICAL_MISMATCH",
    ],
    [
      "unmined transaction block hash",
      (f: ReturnType<typeof fixture>) => {
        f.transaction.blockHash = null;
      },
      "CANONICAL_MISMATCH",
    ],
    [
      "canonical block number mismatch",
      (f: ReturnType<typeof fixture>) => {
        f.block.number = 41;
      },
      "CANONICAL_MISMATCH",
    ],
    [
      "orphaned receipt block",
      (f: ReturnType<typeof fixture>) => {
        f.block.hash = OTHER_BLOCK_HASH;
      },
      "CANONICAL_MISMATCH",
    ],
    [
      "missing canonical block",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getBlock.mockResolvedValue(null),
      "BLOCK_NOT_FOUND",
    ],
  ])("rejects %s", async (_label, mutate, reason) => {
    const current = fixture();
    (mutate as (value: ReturnType<typeof fixture>) => void)(current);
    await expectReason(current, reason as CanonicalTransactionError["reason"]);
  });

  it.each([
    [
      "initial receipt",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransactionReceipt.mockRejectedValueOnce(
          new Error("offline"),
        ),
    ],
    [
      "receipt confirmation",
      (f: ReturnType<typeof fixture>) =>
        f.receipt.confirmations.mockRejectedValueOnce(new Error("offline")),
    ],
    [
      "canonical transaction",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getTransaction.mockRejectedValueOnce(new Error("offline")),
    ],
    [
      "canonical block",
      (f: ReturnType<typeof fixture>) =>
        f.provider.getBlock.mockRejectedValueOnce(new Error("offline")),
    ],
  ])(
    "maps %s RPC failure without leaking provider details",
    async (_label, mutate) => {
      const current = fixture();
      (mutate as (value: ReturnType<typeof fixture>) => void)(current);
      await expectReason(current, "RPC_UNAVAILABLE");
    },
  );
});

describe("assertCanonicalChainSnapshot", () => {
  function snapshotFixture() {
    const current = fixture();
    current.provider.getNetwork = jest
      .fn()
      .mockResolvedValue({ chainId: 7332n });
    current.provider.getBlock.mockImplementation((blockTag: number | bigint) =>
      Promise.resolve(
        blockTag === 1n
          ? { number: 1, hash: `0x${"aa".repeat(32)}` }
          : current.block,
      ),
    );
    return current;
  }

  it("re-reads and enforces receipt depth at the final persistence boundary", async () => {
    const current = snapshotFixture();
    current.receipt.confirmations.mockResolvedValue(1);

    await expect(
      assertCanonicalChainSnapshot(
        current.provider,
        {
          chainId: 7332n,
          networkAnchorBlock: 1n,
          networkAnchorHash: `0x${"aa".repeat(32)}`,
        },
        42,
        BLOCK_HASH,
        TX_HASH,
        2,
      ),
    ).rejects.toMatchObject({
      reason: "INSUFFICIENT_CONFIRMATIONS",
      confirmations: 1,
    });
    expect(current.receipt.confirmations).toHaveBeenCalledTimes(1);
  });

  it("keeps a final confirmation RPC failure distinct from shallow depth", async () => {
    const current = snapshotFixture();
    current.receipt.confirmations.mockRejectedValue(new Error("offline"));

    await expect(
      assertCanonicalChainSnapshot(
        current.provider,
        {
          chainId: 7332n,
          networkAnchorBlock: 1n,
          networkAnchorHash: `0x${"aa".repeat(32)}`,
        },
        42,
        BLOCK_HASH,
        TX_HASH,
        2,
      ),
    ).rejects.toMatchObject({ reason: "RPC_UNAVAILABLE" });
  });
});
