export interface NetworkAnchor {
  blockNumber: bigint;
  blockHash: `0x${string}`;
}

export interface Eip1193Provider {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
}

export interface NetworkAnchorBlock {
  number?: bigint | number | string | null;
  hash?: string | null;
}

const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

export function resolveNetworkAnchor(
  rawBlock = process.env.NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK,
  rawHash = process.env.NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH,
  nodeEnv = process.env.NODE_ENV,
): NetworkAnchor | null {
  const block = rawBlock?.trim();
  const hash = rawHash?.trim();
  if (!block && !hash && nodeEnv !== "production") return null;
  if (!block || !/^\d+$/u.test(block)) {
    throw new Error(
      "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK must be an unsigned integer",
    );
  }
  if (!hash || !BLOCK_HASH_PATTERN.test(hash)) {
    throw new Error(
      "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH must be a 32-byte 0x-prefixed block hash",
    );
  }
  return {
    blockNumber: BigInt(block),
    blockHash: hash.toLowerCase() as `0x${string}`,
  };
}

/**
 * Verify network identity through the provider that will actually prompt the
 * wallet. A matching public dApp RPC is insufficient when an injected wallet
 * is connected to another network that reuses the same chain ID.
 */
export async function verifyWalletNetworkAnchor(
  provider: Eip1193Provider,
  anchor: NetworkAnchor | null,
): Promise<void> {
  if (!anchor) {
    throw new Error(
      "Wallet transaction blocked: the immutable network anchor is not configured",
    );
  }
  const requestedBlock = `0x${anchor.blockNumber.toString(16)}`;
  const response = await provider.request({
    method: "eth_getBlockByNumber",
    params: [requestedBlock, false],
  });
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(
      "Wallet transaction blocked: wallet RPC did not return the network anchor block",
    );
  }
  assertNetworkAnchorBlock(anchor, response as NetworkAnchorBlock, {
    requireHexBlockNumber: true,
    source: "wallet RPC",
  });
}

export async function verifyPublicClientNetworkAnchor(
  client: Eip1193Provider,
  anchor: NetworkAnchor | null,
): Promise<void> {
  if (!anchor) {
    throw new Error("Configured public RPC network anchor is not configured");
  }
  const response = await client.request({
    method: "eth_getBlockByNumber",
    params: [`0x${anchor.blockNumber.toString(16)}`, false],
  });
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(
      "Configured public RPC did not return the network anchor block",
    );
  }
  assertNetworkAnchorBlock(anchor, response as NetworkAnchorBlock, {
    requireHexBlockNumber: true,
    source: "configured public RPC",
  });
}

export function assertNetworkAnchorBlock(
  anchor: NetworkAnchor,
  response: NetworkAnchorBlock | null,
  options: { requireHexBlockNumber?: boolean; source?: string } = {},
): void {
  const source = options.source ?? "RPC";
  const number = response?.number;
  const hash = response?.hash;
  let actualBlock: bigint;
  try {
    if (
      options.requireHexBlockNumber &&
      (typeof number !== "string" || !/^0x[0-9a-fA-F]+$/u.test(number))
    ) {
      throw new Error("invalid block number");
    }
    if (
      number === null ||
      number === undefined ||
      (typeof number === "string" &&
        !/^0x[0-9a-fA-F]+$/u.test(number) &&
        !/^\d+$/u.test(number))
    ) {
      throw new Error("invalid block number");
    }
    actualBlock = BigInt(number);
  } catch {
    throw new Error(
      `Wallet transaction blocked: ${source} returned an invalid network anchor block`,
    );
  }
  if (
    actualBlock !== anchor.blockNumber ||
    typeof hash !== "string" ||
    !BLOCK_HASH_PATTERN.test(hash) ||
    hash.toLowerCase() !== anchor.blockHash
  ) {
    throw new Error(
      `Wallet transaction blocked: ${source} network does not match this NoblePay release`,
    );
  }
}
