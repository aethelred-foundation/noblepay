import {
  Interface,
  JsonRpcProvider,
  getAddress,
  hashMessage,
  verifyMessage,
} from "ethers";
import {
  loadNoblePayChainConfiguration,
  noblePayNetworkIdentityMatches,
} from "./production-config";
import { strictBlockCall } from "./strict-block-rpc";

const EIP1271_INTERFACE = new Interface([
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4 magicValue)",
]);
const EIP1271_MAGIC_VALUE = "0x1626ba7e";
let cachedProvider: { rpcUrl: string; provider: JsonRpcProvider } | null = null;

export interface WalletSignatureChainIdentity {
  rpcUrl: string;
  chainId: bigint;
  networkAnchorBlock: bigint;
  networkAnchorHash: string;
}

/**
 * Verify an EIP-191 message signature for either an EOA or an EIP-1271 smart
 * account. Account type is determined at one anchored canonical chain block;
 * contract-wallet validation is performed at that same block.
 */
export async function isCurrentWalletMessageSignatureValid(
  rawAddress: string,
  message: string,
  signature: string,
  injectedProvider?: JsonRpcProvider,
  injectedIdentity?: WalletSignatureChainIdentity,
): Promise<boolean> {
  try {
    const address = getAddress(rawAddress);
    const config = injectedIdentity || loadNoblePayChainConfiguration();
    const provider = injectedProvider || providerFor(config.rpcUrl);
    const [network, block, anchorBlock] = await Promise.all([
      provider.getNetwork(),
      provider.getBlock("latest"),
      provider.getBlock(config.networkAnchorBlock),
    ]);
    if (
      !block ||
      !block.hash ||
      !Number.isSafeInteger(block.number) ||
      !noblePayNetworkIdentityMatches(config, network, anchorBlock)
    ) {
      throw new Error("configured chain mismatch");
    }

    const code = await provider.getCode(address, block.number);
    let valid: boolean;
    if (code === "0x") {
      try {
        valid = getAddress(verifyMessage(message, signature)) === address;
      } catch {
        valid = false;
      }
    } else {
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
        throw new Error("invalid wallet bytecode response");
      }
      const rawResult = await strictBlockCall(
        provider,
        {
          to: address,
          data: EIP1271_INTERFACE.encodeFunctionData("isValidSignature", [
            hashMessage(message),
            signature,
          ]),
        },
        block.number,
      );
      const [magicValue] = EIP1271_INTERFACE.decodeFunctionResult(
        "isValidSignature",
        rawResult,
      );
      valid =
        typeof magicValue === "string" &&
        magicValue.toLowerCase() === EIP1271_MAGIC_VALUE;
    }

    const [exitNetwork, exitAnchorBlock, canonicalBlock] = await Promise.all([
      provider.getNetwork(),
      provider.getBlock(config.networkAnchorBlock),
      provider.getBlock(block.number),
    ]);
    if (
      !noblePayNetworkIdentityMatches(config, exitNetwork, exitAnchorBlock) ||
      !canonicalBlock ||
      canonicalBlock.number !== block.number ||
      canonicalBlock.hash?.toLowerCase() !== block.hash.toLowerCase()
    ) {
      throw new Error("wallet signature block is not canonical");
    }
    return valid;
  } catch (error) {
    if (error instanceof WalletSignatureAuthorizationError) throw error;
    throw new WalletSignatureAuthorizationError(
      "Unable to verify the wallet signature on the configured chain",
      error,
    );
  }
}

function providerFor(rpcUrl: string): JsonRpcProvider {
  if (!cachedProvider || cachedProvider.rpcUrl !== rpcUrl) {
    cachedProvider = { rpcUrl, provider: new JsonRpcProvider(rpcUrl) };
  }
  return cachedProvider.provider;
}

export class WalletSignatureAuthorizationError extends Error {
  constructor(message: string, options?: unknown) {
    super(message);
    this.name = "WalletSignatureAuthorizationError";
    if (options !== undefined)
      (this as Error & { cause?: unknown }).cause = options;
  }
}
