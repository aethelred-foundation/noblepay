import { Interface } from "ethers";
import {
  runReadinessChecks,
  verifyNoblePayDeployment,
} from "../../services/readiness";

const NOBLEPAY = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const GATE = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const ANCHOR_HASH = `0x${"ab".repeat(32)}`;
const noblepay = new Interface([
  "function trustConfigured() view returns (bool)",
  "function businessRegistry() view returns (address)",
  "function sealSettlementGate() view returns (address)",
  "function supportedTokens(address token) view returns (bool)",
]);
const erc20 = new Interface(["function decimals() view returns (uint8)"]);

describe("runReadinessChecks", () => {
  const healthy = () => ({
    database: jest.fn().mockResolvedValue(undefined),
    compliance: jest.fn().mockResolvedValue(undefined),
    rpc: jest.fn().mockResolvedValue(undefined),
    contracts: jest.fn().mockResolvedValue(undefined),
  });

  it("is ready only when all production dependencies pass", async () => {
    await expect(runReadinessChecks(healthy(), 100)).resolves.toEqual({
      ready: true,
      checks: {
        database: "ready",
        compliance: "ready",
        rpc: "ready",
        contracts: "ready",
      },
    });
  });

  it("fails closed and exposes only coarse states", async () => {
    const dependencies = healthy();
    dependencies.compliance.mockRejectedValue(
      new Error("secret upstream detail"),
    );
    const result = await runReadinessChecks(dependencies, 100);
    expect(result.ready).toBe(false);
    expect(result.checks.compliance).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("secret upstream detail");
  });

  it("bounds checks that never settle", async () => {
    const dependencies = healthy();
    dependencies.rpc.mockImplementation(() => new Promise(() => undefined));
    const result = await runReadinessChecks(dependencies, 5);
    expect(result.ready).toBe(false);
    expect(result.checks.rpc).toBe("unavailable");
  });
});

describe("NoblePay deployment readiness", () => {
  const config: any = {
    rpcUrl: "https://rpc.aethelred.network",
    chainId: 7332n,
    networkAnchorBlock: 1n,
    networkAnchorHash: ANCHOR_HASH,
    contractAddress: NOBLEPAY,
    registryContractAddress: REGISTRY,
    minimumConfirmations: 2,
    tokens: [
      { address: TOKEN, currency: "USDC", currencyCode: "USD", decimals: 6 },
    ],
  };

  function provider(
    overrides: {
      chainId?: bigint;
      block?: { number: number; timestamp: number } | null;
      anchorBlock?: { number: number; hash: string } | null;
      missingCodeAt?: string;
      registry?: string;
      trustConfigured?: boolean;
      gate?: string;
      supported?: boolean;
      decimals?: number;
    } = {},
  ) {
    return {
      getNetwork: jest
        .fn()
        .mockResolvedValue({ chainId: overrides.chainId ?? 7332n }),
      getBlock: jest.fn().mockImplementation((blockTag: string | bigint) => {
        if (blockTag === 1n) {
          return Promise.resolve(
            overrides.anchorBlock === undefined
              ? { number: 1, hash: ANCHOR_HASH }
              : overrides.anchorBlock,
          );
        }
        return Promise.resolve(
          overrides.block === undefined
            ? { number: 100, timestamp: 1_750_000_000 }
            : overrides.block,
        );
      }),
      getCode: jest.fn(async (address: string) =>
        address === overrides.missingCodeAt ? "0x" : "0x60006000",
      ),
      call: jest.fn(async ({ to, data }: { to: string; data: string }) => {
        if (to === TOKEN) {
          return erc20.encodeFunctionResult("decimals", [
            overrides.decimals ?? 6,
          ]);
        }
        if (
          data.startsWith(noblepay.getFunction("trustConfigured")!.selector)
        ) {
          return noblepay.encodeFunctionResult("trustConfigured", [
            overrides.trustConfigured ?? true,
          ]);
        }
        if (
          data.startsWith(noblepay.getFunction("businessRegistry")!.selector)
        ) {
          return noblepay.encodeFunctionResult("businessRegistry", [
            overrides.registry ?? REGISTRY,
          ]);
        }
        if (
          data.startsWith(noblepay.getFunction("sealSettlementGate")!.selector)
        ) {
          return noblepay.encodeFunctionResult("sealSettlementGate", [
            overrides.gate ?? GATE,
          ]);
        }
        return noblepay.encodeFunctionResult("supportedTokens", [
          overrides.supported ?? true,
        ]);
      }),
    } as any;
  }

  it("accepts only fully wired trust, registry, gate and six-decimal supported tokens", async () => {
    const rpc = provider();
    await expect(
      verifyNoblePayDeployment(config, rpc),
    ).resolves.toBeUndefined();
    expect(rpc.getCode).toHaveBeenCalledWith(GATE, 100);
    expect(rpc.getCode).toHaveBeenCalledWith(TOKEN, 100);
  });

  it("fails closed when the deployed registry or token allowlist is miswired", async () => {
    await expect(
      verifyNoblePayDeployment(config, provider({ registry: OTHER })),
    ).rejects.toThrow("registry wiring mismatch");
    await expect(
      verifyNoblePayDeployment(config, provider({ supported: false })),
    ).rejects.toThrow("not supported");
    await expect(
      verifyNoblePayDeployment(config, provider({ decimals: 18 })),
    ).rejects.toThrow("six decimals");
  });

  it("rejects a different chain or an unavailable latest block", async () => {
    await expect(
      verifyNoblePayDeployment(config, provider({ chainId: 1n })),
    ).rejects.toThrow("chain mismatch");
    await expect(
      verifyNoblePayDeployment(config, provider({ block: null })),
    ).rejects.toThrow("chain mismatch");
  });

  it("rejects a missing or different immutable network anchor", async () => {
    await expect(
      verifyNoblePayDeployment(config, provider({ anchorBlock: null })),
    ).rejects.toThrow("network anchor mismatch");
    await expect(
      verifyNoblePayDeployment(
        config,
        provider({
          anchorBlock: { number: 1, hash: `0x${"cd".repeat(32)}` },
        }),
      ),
    ).rejects.toThrow("network anchor mismatch");
  });

  it("rejects missing bytecode for every required deployment", async () => {
    await expect(
      verifyNoblePayDeployment(config, provider({ missingCodeAt: NOBLEPAY })),
    ).rejects.toThrow("required contract bytecode missing");
    await expect(
      verifyNoblePayDeployment(config, provider({ missingCodeAt: REGISTRY })),
    ).rejects.toThrow("required contract bytecode missing");
    await expect(
      verifyNoblePayDeployment(config, provider({ missingCodeAt: TOKEN })),
    ).rejects.toThrow("required contract bytecode missing");
  });

  it("requires the payment contract trust and settlement gate wiring", async () => {
    await expect(
      verifyNoblePayDeployment(config, provider({ trustConfigured: false })),
    ).rejects.toThrow("trust is not configured");
    await expect(
      verifyNoblePayDeployment(
        config,
        provider({ gate: "0x0000000000000000000000000000000000000000" }),
      ),
    ).rejects.toThrow("settlement gate missing");
    await expect(
      verifyNoblePayDeployment(config, provider({ missingCodeAt: GATE })),
    ).rejects.toThrow("settlement gate bytecode missing");
  });
});
