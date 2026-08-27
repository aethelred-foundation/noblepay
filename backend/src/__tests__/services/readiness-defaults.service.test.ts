const mockPrisma = { $queryRaw: jest.fn() };
const mockLoadChainConfiguration = jest.fn();
const mockParseComplianceUrl = jest.fn();
const mockReadBoundedJson = jest.fn();
const mockValidateSanctionsMetadata = jest.fn();
const mockJsonRpcProvider = jest.fn();

jest.mock("../../lib/db", () => ({ prisma: mockPrisma }));
jest.mock("../../lib/production-config", () => ({
  // These tests cover the real compliance probe, so evaluation mode is off.
  // Its own behaviour is covered in lib/compliance-evaluation-mode.test.ts.
  complianceEvaluationAcknowledged: () => false,
  loadNoblePayChainConfiguration: () => mockLoadChainConfiguration(),
  noblePayNetworkIdentityMatches: (
    config: {
      chainId: bigint;
      networkAnchorBlock: bigint;
      networkAnchorHash: string;
    },
    network: { chainId: bigint },
    block: { number: number; hash: string } | null,
  ) =>
    network.chainId === config.chainId &&
    BigInt(block?.number ?? -1) === config.networkAnchorBlock &&
    block?.hash.toLowerCase() === config.networkAnchorHash,
  parseExternalComplianceUrl: (raw: string | undefined) =>
    mockParseComplianceUrl(raw),
}));
jest.mock("../../lib/bounded-response", () => ({
  readBoundedJsonResponse: (response: Response, limit: number) =>
    mockReadBoundedJson(response, limit),
}));
jest.mock("../../services/compliance", () => ({
  validateSanctionsMetadata: (metadata: Record<string, unknown>) =>
    mockValidateSanctionsMetadata(metadata),
}));
jest.mock("ethers", () => {
  const actual = jest.requireActual("ethers");
  return { ...actual, JsonRpcProvider: mockJsonRpcProvider };
});

import { Interface } from "ethers";
import { createDefaultReadinessDependencies } from "../../services/readiness";

const NOBLEPAY = "0x1111111111111111111111111111111111111111";
const REGISTRY = "0x2222222222222222222222222222222222222222";
const GATE = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const ANCHOR_HASH = `0x${"ab".repeat(32)}`;
const noblepay = new Interface([
  "function trustConfigured() view returns (bool)",
  "function businessRegistry() view returns (address)",
  "function sealSettlementGate() view returns (address)",
  "function supportedTokens(address token) view returns (bool)",
]);
const erc20 = new Interface(["function decimals() view returns (uint8)"]);

describe("default readiness dependencies", () => {
  const chainConfig = {
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
  let rpc: Record<string, jest.Mock>;
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([{ ok: 1 }]);
    mockLoadChainConfiguration.mockReturnValue(chainConfig);
    mockParseComplianceUrl.mockReturnValue(
      new URL("https://compliance.aethelred.network"),
    );
    rpc = {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: ANCHOR_HASH }
              : { number: 100, timestamp: 1_750_000_000 },
          ),
        ),
    };
    mockJsonRpcProvider.mockImplementation(() => rpc);
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    mockReadBoundedJson.mockResolvedValue({
      status: "healthy",
      sanctions_lists: { source: "OFAC", version: "2026-07-22" },
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("checks the database with a harmless query", async () => {
    const dependencies = createDefaultReadinessDependencies();
    await expect(dependencies.database()).resolves.toBeUndefined();
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("validates the external compliance service and its sanctions metadata", async () => {
    const dependencies = createDefaultReadinessDependencies();
    await expect(dependencies.compliance()).resolves.toBeUndefined();

    expect(mockParseComplianceUrl).toHaveBeenCalledWith(
      process.env.COMPLIANCE_API_URL,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "https://compliance.aethelred.network/v1/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockReadBoundedJson).toHaveBeenCalledWith(
      expect.anything(),
      64 * 1024,
    );
    expect(mockValidateSanctionsMetadata).toHaveBeenCalledWith({
      source: "OFAC",
      version: "2026-07-22",
    });
  });

  it("fails closed for an HTTP error or an unhealthy compliance response", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
    } as Response);
    await expect(
      createDefaultReadinessDependencies().compliance(),
    ).rejects.toThrow("compliance unavailable");

    mockReadBoundedJson.mockResolvedValueOnce({
      status: "degraded",
      sanctions_lists: { source: "OFAC" },
    });
    await expect(
      createDefaultReadinessDependencies().compliance(),
    ).rejects.toThrow("compliance unhealthy");
  });

  it.each([
    [undefined, "missing"],
    [null, "null"],
    [[], "array"],
    ["OFAC", "string"],
  ])("rejects %s sanctions metadata (%s)", async (sanctionsLists, _label) => {
    mockReadBoundedJson.mockResolvedValueOnce({
      status: "healthy",
      sanctions_lists: sanctionsLists,
    });
    await expect(
      createDefaultReadinessDependencies().compliance(),
    ).rejects.toThrow("sanctions metadata missing");
    expect(mockValidateSanctionsMetadata).not.toHaveBeenCalled();
  });

  it("checks the configured chain and reuses one provider", async () => {
    const dependencies = createDefaultReadinessDependencies();
    await expect(dependencies.rpc()).resolves.toBeUndefined();
    await expect(dependencies.rpc()).resolves.toBeUndefined();

    expect(mockJsonRpcProvider).toHaveBeenCalledTimes(1);
    expect(mockJsonRpcProvider).toHaveBeenCalledWith(chainConfig.rpcUrl);
    expect(rpc.getNetwork).toHaveBeenCalledTimes(2);
    expect(rpc.getBlock).toHaveBeenNthCalledWith(1, 1n);
    expect(rpc.getBlock).toHaveBeenNthCalledWith(2, 1n);
  });

  it("rejects an RPC endpoint connected to the wrong chain", async () => {
    rpc.getNetwork.mockResolvedValueOnce({ chainId: 1n });
    await expect(createDefaultReadinessDependencies().rpc()).rejects.toThrow(
      "chain mismatch",
    );
  });

  it("rejects an RPC endpoint with a different anchor block hash", async () => {
    rpc.getBlock.mockResolvedValueOnce({
      number: 1,
      hash: `0x${"cd".repeat(32)}`,
    });
    await expect(createDefaultReadinessDependencies().rpc()).rejects.toThrow(
      "network anchor mismatch",
    );
  });

  it("checks the configured contracts through the shared chain provider", async () => {
    rpc.getBlock = jest
      .fn()
      .mockImplementation((blockTag: string | bigint) =>
        Promise.resolve(
          blockTag === 1n
            ? { number: 1, hash: ANCHOR_HASH }
            : { number: 100, timestamp: 1_750_000_000 },
        ),
      );
    rpc.getCode = jest.fn().mockResolvedValue("0x60006000");
    rpc.call = jest.fn(async ({ to, data }: { to: string; data: string }) => {
      if (to === TOKEN) return erc20.encodeFunctionResult("decimals", [6]);
      if (data.startsWith(noblepay.getFunction("trustConfigured")!.selector)) {
        return noblepay.encodeFunctionResult("trustConfigured", [true]);
      }
      if (data.startsWith(noblepay.getFunction("businessRegistry")!.selector)) {
        return noblepay.encodeFunctionResult("businessRegistry", [REGISTRY]);
      }
      if (
        data.startsWith(noblepay.getFunction("sealSettlementGate")!.selector)
      ) {
        return noblepay.encodeFunctionResult("sealSettlementGate", [GATE]);
      }
      return noblepay.encodeFunctionResult("supportedTokens", [true]);
    });

    const dependencies = createDefaultReadinessDependencies();
    await expect(dependencies.contracts()).resolves.toBeUndefined();
    expect(mockJsonRpcProvider).toHaveBeenCalledTimes(1);
    expect(rpc.getCode).toHaveBeenCalledWith(GATE, 100);
  });
});
