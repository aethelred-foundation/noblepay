import { Interface, JsonRpcProvider, getAddress, id } from "ethers";
import {
  loadNoblePayChainConfiguration,
  noblePayNetworkIdentityMatches,
} from "./production-config";
import { strictBlockCall } from "./strict-block-rpc";

const REGISTRY_AUTHORIZATION_INTERFACE = new Interface([
  "function getBusinessDetails(address business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "function isBusinessActive(address business) view returns (bool)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);
const ADMIN_ROLE = id("ADMIN_ROLE");
const REVERIFICATION_INTERVAL_SECONDS = 365n * 24n * 60n * 60n;
const CHAIN_KYC_STATUSES = [
  "PENDING",
  "VERIFIED",
  "SUSPENDED",
  "REVOKED",
] as const;
const CHAIN_BUSINESS_TIERS = ["STANDARD", "PREMIUM", "ENTERPRISE"] as const;

export type CurrentChainKYCStatus = (typeof CHAIN_KYC_STATUSES)[number];
export type CurrentChainBusinessTier = (typeof CHAIN_BUSINESS_TIERS)[number];

export interface CurrentBusinessRegistryAuthorization {
  wallet: string;
  status: CurrentChainKYCStatus;
  tier: CurrentChainBusinessTier;
  active: boolean;
  isAdmin: boolean;
  registeredAt: bigint;
  lastVerified: bigint;
  expiresAt: bigint | null;
  blockNumber: number;
  blockHash: string;
}

let cachedProvider: { rpcUrl: string; provider: JsonRpcProvider } | null = null;

/**
 * Read all request-authorization facts from one canonical BusinessRegistry
 * block. Nothing in this path is cached: suspension, revocation, role removal,
 * tier changes and annual KYC expiry therefore take effect on the next
 * authenticated request.
 */
export async function getCurrentBusinessRegistryAuthorization(
  rawAddress: string,
  injectedProvider?: JsonRpcProvider,
): Promise<CurrentBusinessRegistryAuthorization> {
  try {
    const address = getAddress(rawAddress);
    const config = loadNoblePayChainConfiguration();
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
      !Number.isSafeInteger(block.timestamp) ||
      !noblePayNetworkIdentityMatches(config, network, anchorBlock)
    ) {
      throw new Error("configured chain mismatch");
    }

    const registryCode = await provider.getCode(
      config.registryContractAddress,
      block.number,
    );
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(registryCode)) {
      throw new Error("BusinessRegistry bytecode missing");
    }

    const [detailsRaw, activeRaw, adminRaw] = await Promise.all([
      strictBlockCall(
        provider,
        {
          to: config.registryContractAddress,
          data: REGISTRY_AUTHORIZATION_INTERFACE.encodeFunctionData(
            "getBusinessDetails",
            [address],
          ),
        },
        block.number,
      ),
      strictBlockCall(
        provider,
        {
          to: config.registryContractAddress,
          data: REGISTRY_AUTHORIZATION_INTERFACE.encodeFunctionData(
            "isBusinessActive",
            [address],
          ),
        },
        block.number,
      ),
      strictBlockCall(
        provider,
        {
          to: config.registryContractAddress,
          data: REGISTRY_AUTHORIZATION_INTERFACE.encodeFunctionData("hasRole", [
            ADMIN_ROLE,
            address,
          ]),
        },
        block.number,
      ),
    ]);

    const [details] = REGISTRY_AUTHORIZATION_INTERFACE.decodeFunctionResult(
      "getBusinessDetails",
      detailsRaw,
    );
    const [contractActive] =
      REGISTRY_AUTHORIZATION_INTERFACE.decodeFunctionResult(
        "isBusinessActive",
        activeRaw,
      );
    const [isAdmin] = REGISTRY_AUTHORIZATION_INTERFACE.decodeFunctionResult(
      "hasRole",
      adminRaw,
    );

    const statusValue = Number(details.kycStatus);
    const tierValue = Number(details.tier);
    const status = CHAIN_KYC_STATUSES[statusValue];
    const tier = CHAIN_BUSINESS_TIERS[tierValue];
    const registeredAt = BigInt(details.registeredAt);
    const lastVerified = BigInt(details.lastVerified);
    const blockTimestamp = BigInt(block.timestamp);
    if (
      getAddress(details.wallet as string) !== address ||
      registeredAt === 0n ||
      !status ||
      !tier ||
      typeof contractActive !== "boolean" ||
      typeof isAdmin !== "boolean"
    ) {
      throw new Error("invalid BusinessRegistry authorization response");
    }

    const expiresAt =
      status === "VERIFIED"
        ? lastVerified + REVERIFICATION_INTERVAL_SECONDS
        : null;
    const computedActive =
      status === "VERIFIED" &&
      lastVerified > 0n &&
      expiresAt !== null &&
      expiresAt > blockTimestamp;
    if (contractActive !== computedActive) {
      throw new Error("inconsistent BusinessRegistry active status");
    }

    // Detect a reorg/drift during the multi-call authorization read. A view
    // assembled from an orphaned head must never grant backend access.
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
      throw new Error("BusinessRegistry authorization block is not canonical");
    }

    return {
      wallet: address,
      status,
      tier,
      active: computedActive,
      isAdmin,
      registeredAt,
      lastVerified,
      expiresAt,
      blockNumber: block.number,
      blockHash: block.hash.toLowerCase(),
    };
  } catch (error) {
    if (error instanceof BusinessRegistryAuthorizationError) throw error;
    throw new BusinessRegistryAuthorizationError(
      "Unable to verify the current BusinessRegistry authorization state",
      error,
    );
  }
}

/** Read the current platform-admin role without caching revocable authority. */
export async function hasCurrentBusinessRegistryAdminRole(
  rawAddress: string,
  injectedProvider?: JsonRpcProvider,
): Promise<boolean> {
  return (
    await getCurrentBusinessRegistryAuthorization(rawAddress, injectedProvider)
  ).isAdmin;
}

function providerFor(rpcUrl: string): JsonRpcProvider {
  if (!cachedProvider || cachedProvider.rpcUrl !== rpcUrl) {
    cachedProvider = { rpcUrl, provider: new JsonRpcProvider(rpcUrl) };
  }
  return cachedProvider.provider;
}

export class BusinessRegistryAuthorizationError extends Error {
  constructor(message: string, options?: unknown) {
    super(message);
    this.name = "BusinessRegistryAuthorizationError";
    if (options !== undefined)
      (this as Error & { cause?: unknown }).cause = options;
  }
}
