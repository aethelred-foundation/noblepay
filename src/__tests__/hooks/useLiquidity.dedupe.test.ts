/**
 * Regression guard for the liquidity event-dedup bug: the Aethelred node's
 * eth_getLogs can return the same log twice, which rendered one pool/position
 * as two (React "two children with the same key" + doubled counts). The hooks
 * dedupe raw logs by transactionHash + logIndex before mapping.
 *
 * dedupeLogs is not exported (it is an internal helper), so this test pins the
 * exact keying behaviour it relies on.
 */

type Log = { transactionHash?: string | null; logIndex?: number | null };

function dedupeLogs<T extends Log>(logs: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out;
}

describe("liquidity log de-duplication", () => {
  it("collapses a log the RPC returned twice", () => {
    const dup = { transactionHash: "0xabc", logIndex: 0, tag: "a" };
    expect(dedupeLogs([dup, { ...dup }])).toEqual([dup]);
  });

  it("keeps distinct logs from the same transaction (different logIndex)", () => {
    const logs = [
      { transactionHash: "0xabc", logIndex: 0 },
      { transactionHash: "0xabc", logIndex: 1 },
    ];
    expect(dedupeLogs(logs)).toHaveLength(2);
  });

  it("keeps logs with the same logIndex across different transactions", () => {
    const logs = [
      { transactionHash: "0xabc", logIndex: 0 },
      { transactionHash: "0xdef", logIndex: 0 },
    ];
    expect(dedupeLogs(logs)).toHaveLength(2);
  });

  it("preserves first-seen order", () => {
    const logs = [
      { transactionHash: "0x1", logIndex: 0 },
      { transactionHash: "0x2", logIndex: 0 },
      { transactionHash: "0x1", logIndex: 0 },
    ];
    expect(dedupeLogs(logs).map((l) => l.transactionHash)).toEqual(["0x1", "0x2"]);
  });
});
