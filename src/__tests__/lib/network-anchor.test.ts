import {
  resolveNetworkAnchor,
  verifyWalletNetworkAnchor,
  verifyPublicClientNetworkAnchor,
} from "@/lib/network-anchor";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("immutable Aethelred network anchor", () => {
  it("requires both values for production and normalizes the hash", () => {
    expect(resolveNetworkAnchor("", "", "test")).toBeNull();
    expect(
      resolveNetworkAnchor(
        "1",
        HASH.toUpperCase().replace("0X", "0x"),
        "production",
      ),
    ).toEqual({
      blockNumber: 1n,
      blockHash: HASH,
    });
    expect(() => resolveNetworkAnchor("", HASH, "production")).toThrow(
      /ANCHOR_BLOCK/u,
    );
    expect(() => resolveNetworkAnchor("1", "0x1234", "production")).toThrow(
      /ANCHOR_HASH/u,
    );
  });

  it("queries the exact anchor through EIP-1193 and accepts only its hash", async () => {
    const request = jest.fn().mockResolvedValue({ number: "0x1", hash: HASH });
    await expect(
      verifyWalletNetworkAnchor(
        { request },
        { blockNumber: 1n, blockHash: HASH },
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({
      method: "eth_getBlockByNumber",
      params: ["0x1", false],
    });
  });

  it("uses the configured public JSON-RPC client as a separate anchor source", async () => {
    const request = jest.fn().mockResolvedValue({ number: "0x1", hash: HASH });
    await expect(
      verifyPublicClientNetworkAnchor(
        { request },
        { blockNumber: 1n, blockHash: HASH },
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith({
      method: "eth_getBlockByNumber",
      params: ["0x1", false],
    });
  });

  it.each([
    [null, /did not return/u],
    [{ number: "0x2", hash: HASH }, /does not match/u],
    [{ number: "0x1", hash: `0x${"cd".repeat(32)}` }, /does not match/u],
    [{ number: "1", hash: HASH }, /invalid/u],
  ])("fails closed for wallet response %#", async (response, message) => {
    await expect(
      verifyWalletNetworkAnchor(
        { request: jest.fn().mockResolvedValue(response) },
        { blockNumber: 1n, blockHash: HASH },
      ),
    ).rejects.toThrow(message);
  });
});
