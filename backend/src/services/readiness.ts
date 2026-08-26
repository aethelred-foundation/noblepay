import { Interface, JsonRpcProvider, ZeroAddress, getAddress } from "ethers";
import { prisma } from "../lib/db";
import {
  complianceEvaluationAcknowledged,
  loadNoblePayChainConfiguration,
  NoblePayChainConfiguration,
  noblePayNetworkIdentityMatches,
  parseExternalComplianceUrl,
} from "../lib/production-config";
import { validateSanctionsMetadata } from "./compliance";
import { readBoundedJsonResponse } from "../lib/bounded-response";

const NOBLEPAY_READINESS_INTERFACE = new Interface([
  "function trustConfigured() view returns (bool)",
  "function businessRegistry() view returns (address)",
  "function sealSettlementGate() view returns (address)",
  "function supportedTokens(address token) view returns (bool)",
]);
const ERC20_METADATA_INTERFACE = new Interface([
  "function decimals() view returns (uint8)",
]);

export type ReadinessState = "ready" | "unavailable";

/**
 * Compliance has a third state the others do not.
 *
 * Reporting "ready" when no compliance service exists would tell a monitoring
 * system that screening works. Reporting "unavailable" would keep the container
 * unhealthy forever. Neither is true, so evaluation mode says so in its own
 * word and anything reading /readyz has to notice it.
 */
export type ComplianceReadinessState =
  | ReadinessState
  | "evaluation-unconfigured";

export interface ReadinessDependencies {
  database(): Promise<void>;
  compliance(): Promise<void>;
  rpc(): Promise<void>;
  contracts(): Promise<void>;
}

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: ReadinessState;
    compliance: ComplianceReadinessState;
    rpc: ReadinessState;
    contracts: ReadinessState;
  };
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("readiness timeout")),
      timeoutMs,
    );
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runReadinessChecks(
  dependencies: ReadinessDependencies,
  timeoutMs = 5_000,
  evaluationMode = complianceEvaluationAcknowledged(),
): Promise<ReadinessResult> {
  const names = ["database", "compliance", "rpc", "contracts"] as const;
  const results = await Promise.allSettled(
    names.map((name) => bounded(dependencies[name](), timeoutMs)),
  );
  const checks = Object.fromEntries(
    names.map((name, index) => [
      name,
      results[index].status === "fulfilled" ? "ready" : "unavailable",
    ]),
  ) as ReadinessResult["checks"];

  // Distinguish "no compliance service, and we said so" from "the compliance
  // service is down". Only the former lets the container become healthy.
  if (evaluationMode && checks.compliance === "ready") {
    checks.compliance = "evaluation-unconfigured";
  }

  return {
    ready: Object.values(checks).every(
      (state) => state === "ready" || state === "evaluation-unconfigured",
    ),
    checks,
  };
}

export function createDefaultReadinessDependencies(): ReadinessDependencies {
  let provider: JsonRpcProvider | null = null;
  const chainProvider = () => {
    const config = loadNoblePayChainConfiguration();
    if (!provider) provider = new JsonRpcProvider(config.rpcUrl);
    return { config, provider };
  };

  return {
    async database() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async compliance() {
      // Nothing to probe when no compliance service is configured and that has
      // been acknowledged. runReadinessChecks relabels this as
      // "evaluation-unconfigured" so the absence stays visible.
      if (complianceEvaluationAcknowledged() && !process.env.COMPLIANCE_API_URL) {
        return;
      }
      const baseUrl = parseExternalComplianceUrl(
        process.env.COMPLIANCE_API_URL,
      ).origin;
      const response = await fetch(`${baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(4_500),
      });
      if (!response.ok) throw new Error("compliance unavailable");
      const payload = await readBoundedJsonResponse<Record<string, unknown>>(
        response,
        64 * 1024,
      );
      if (payload.status !== "healthy") throw new Error("compliance unhealthy");
      const metadata = payload.sanctions_lists;
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        throw new Error("sanctions metadata missing");
      }
      validateSanctionsMetadata(metadata as Record<string, unknown>);
    },
    async rpc() {
      const { config, provider: rpcProvider } = chainProvider();
      await verifyConfiguredNetwork(config, rpcProvider);
    },
    async contracts() {
      const { config, provider: rpcProvider } = chainProvider();
      await verifyNoblePayDeployment(config, rpcProvider);
    },
  };
}

export async function verifyConfiguredNetwork(
  config: NoblePayChainConfiguration,
  provider: JsonRpcProvider,
): Promise<void> {
  const [network, anchorBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock(config.networkAnchorBlock),
  ]);
  if (network.chainId !== config.chainId) throw new Error("chain mismatch");
  if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
    throw new Error("network anchor mismatch");
  }
}

/**
 * Prove that every contract dependency required to accept a payment is wired
 * on the configured chain. All state and bytecode reads use one provider and
 * one block so readiness cannot combine values from different chain heads.
 */
export async function verifyNoblePayDeployment(
  config: NoblePayChainConfiguration,
  provider: JsonRpcProvider,
): Promise<void> {
  const [network, block, anchorBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock("latest"),
    provider.getBlock(config.networkAnchorBlock),
  ]);
  if (network.chainId !== config.chainId || !block)
    throw new Error("chain mismatch");
  if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
    throw new Error("network anchor mismatch");
  }
  const blockTag = block.number;

  const [noblePayCode, registryCode, ...tokenCodes] = await Promise.all([
    provider.getCode(config.contractAddress, blockTag),
    provider.getCode(config.registryContractAddress, blockTag),
    ...config.tokens.map((token) => provider.getCode(token.address, blockTag)),
  ]);
  if (![noblePayCode, registryCode, ...tokenCodes].every(hasBytecode)) {
    throw new Error("required contract bytecode missing");
  }

  const [trustResult, registryResult, gateResult, ...tokenResults] =
    await Promise.all([
      contractRead(
        provider,
        NOBLEPAY_READINESS_INTERFACE,
        config.contractAddress,
        "trustConfigured",
        [],
        blockTag,
      ),
      contractRead(
        provider,
        NOBLEPAY_READINESS_INTERFACE,
        config.contractAddress,
        "businessRegistry",
        [],
        blockTag,
      ),
      contractRead(
        provider,
        NOBLEPAY_READINESS_INTERFACE,
        config.contractAddress,
        "sealSettlementGate",
        [],
        blockTag,
      ),
      ...config.tokens.flatMap((token) => [
        contractRead(
          provider,
          NOBLEPAY_READINESS_INTERFACE,
          config.contractAddress,
          "supportedTokens",
          [token.address],
          blockTag,
        ),
        contractRead(
          provider,
          ERC20_METADATA_INTERFACE,
          token.address,
          "decimals",
          [],
          blockTag,
        ),
      ]),
    ]);

  if (trustResult[0] !== true)
    throw new Error("NoblePay trust is not configured");
  if (
    getAddress(registryResult[0] as string) !== config.registryContractAddress
  ) {
    throw new Error("NoblePay registry wiring mismatch");
  }
  const gateAddress = getAddress(gateResult[0] as string);
  if (gateAddress === ZeroAddress) throw new Error("settlement gate missing");
  const gateCode = await provider.getCode(gateAddress, blockTag);
  if (!hasBytecode(gateCode))
    throw new Error("settlement gate bytecode missing");

  for (let index = 0; index < config.tokens.length; index++) {
    const supported = tokenResults[index * 2][0];
    const decimals = Number(tokenResults[index * 2 + 1][0]);
    if (supported !== true)
      throw new Error("configured token is not supported by NoblePay");
    if (decimals !== 6)
      throw new Error("configured token does not have six decimals");
  }
}

async function contractRead(
  provider: JsonRpcProvider,
  contractInterface: Interface,
  address: string,
  method: string,
  args: readonly unknown[],
  blockTag: number,
) {
  const data = contractInterface.encodeFunctionData(method, args);
  const raw = await provider.call({ to: address, data, blockTag });
  return contractInterface.decodeFunctionResult(method, raw);
}

function hasBytecode(code: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(code) && code.length > 2;
}
