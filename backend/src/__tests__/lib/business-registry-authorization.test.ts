import { Interface } from "ethers";
import {
  getCurrentBusinessRegistryAuthorization,
  hasCurrentBusinessRegistryAdminRole,
} from "../../lib/business-registry-authorization";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const NOBLEPAY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const WALLET = "0x4444444444444444444444444444444444444444";
const HEAD_HASH = `0x${"cd".repeat(32)}`;
const registry = new Interface([
  "function getBusinessDetails(address business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "function isBusinessActive(address business) view returns (bool)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);

describe("current BusinessRegistry authorization", () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const key of [
      "AETHELRED_RPC_URL",
      "NOBLEPAY_CHAIN_ID",
      "AETHELRED_NETWORK_ANCHOR_BLOCK",
      "AETHELRED_NETWORK_ANCHOR_HASH",
      "NOBLEPAY_CONTRACT_ADDRESS",
      "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
      "NOBLEPAY_MIN_CONFIRMATIONS",
      "NOBLEPAY_TOKEN_CONFIG",
    ])
      original[key] = process.env[key];
  });
  beforeEach(() => {
    process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
    process.env.NOBLEPAY_CHAIN_ID = "7332";
    process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
    process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"ab".repeat(32)}`;
    process.env.NOBLEPAY_CONTRACT_ADDRESS = NOBLEPAY;
    process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS = REGISTRY;
    process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
    process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
      [TOKEN]: { currency: "USDC", currencyCode: "USD", decimals: 6 },
    });
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function provider(
    options: {
      status?: number;
      tier?: number;
      lastVerified?: bigint;
      active?: boolean;
      adminResults?: boolean[];
    } = {},
  ) {
    const timestamp = 1_750_000_000;
    const status = options.status ?? 1;
    const lastVerified = options.lastVerified ?? BigInt(timestamp - 60);
    const active = options.active ?? status === 1;
    const adminResults = [...(options.adminResults ?? [false])];
    const call = jest.fn().mockImplementation(({ data }: { data: string }) => {
      if (
        data.startsWith(registry.getFunction("getBusinessDetails")!.selector)
      ) {
        return Promise.resolve(
          registry.encodeFunctionResult("getBusinessDetails", [
            [
              WALLET,
              "DMCC123456",
              "Acme Treasury",
              0,
              status,
              options.tier ?? 0,
              1_700_000_000n,
              lastVerified,
              WALLET,
            ],
          ]),
        );
      }
      if (data.startsWith(registry.getFunction("isBusinessActive")!.selector))
        return Promise.resolve(
          registry.encodeFunctionResult("isBusinessActive", [active]),
        );
      return Promise.resolve(
        registry.encodeFunctionResult("hasRole", [
          adminResults.shift() ?? false,
        ]),
      );
    });
    return {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getBlock: jest.fn().mockImplementation((blockTag: string | bigint) => {
        if (blockTag === 1n)
          return Promise.resolve({
            number: 1,
            hash: `0x${"ab".repeat(32)}`,
            timestamp: 1,
          });
        return Promise.resolve({
          number: 100,
          hash: HEAD_HASH,
          timestamp,
        });
      }),
      getCode: jest.fn().mockResolvedValue("0x6000"),
      call,
      send: jest.fn((_method: string, [request]: [{ data: string }]) =>
        call(request),
      ),
    } as any;
  }

  it("returns current active status, chain tier and ADMIN_ROLE from one canonical block", async () => {
    const rpc = provider({ tier: 2, adminResults: [true] });
    await expect(
      getCurrentBusinessRegistryAuthorization(WALLET, rpc),
    ).resolves.toMatchObject({
      wallet: WALLET,
      status: "VERIFIED",
      tier: "ENTERPRISE",
      active: true,
      isAdmin: true,
      blockNumber: 100,
      blockHash: HEAD_HASH,
    });
    expect(rpc.getCode).toHaveBeenCalledWith(REGISTRY, 100);
    expect(rpc.send).toHaveBeenCalledTimes(3);
    for (const [, [request, blockTag]] of rpc.send.mock.calls) {
      expect(request).toMatchObject({ to: REGISTRY });
      expect(blockTag).toBe("0x64");
    }
  });

  it.each([
    ["PENDING", 0, 0n],
    ["SUSPENDED", 2, 1_749_999_900n],
    ["REVOKED", 3, 1_749_999_900n],
  ])(
    "treats %s chain status as inactive",
    async (name, status, lastVerified) => {
      await expect(
        getCurrentBusinessRegistryAuthorization(
          WALLET,
          provider({ status, lastVerified, active: false }),
        ),
      ).resolves.toMatchObject({ status: name, active: false });
    },
  );

  it("treats exact annual KYC expiry as inactive", async () => {
    const oneYear = 365n * 24n * 60n * 60n;
    await expect(
      getCurrentBusinessRegistryAuthorization(
        WALLET,
        provider({
          status: 1,
          lastVerified: 1_750_000_000n - oneYear,
          active: false,
        }),
      ),
    ).resolves.toMatchObject({ status: "VERIFIED", active: false });
  });

  it("does not cache privilege after ADMIN_ROLE is revoked", async () => {
    const rpc = provider({ adminResults: [true, false] });
    await expect(
      hasCurrentBusinessRegistryAdminRole(WALLET, rpc),
    ).resolves.toBe(true);
    await expect(
      hasCurrentBusinessRegistryAdminRole(WALLET, rpc),
    ).resolves.toBe(false);
  });

  it("fails closed on RPC failure, anchor drift, head reorg and inconsistent active response", async () => {
    const offline = provider();
    offline.send.mockRejectedValueOnce(new Error("rpc offline"));
    await expect(
      getCurrentBusinessRegistryAuthorization(WALLET, offline),
    ).rejects.toMatchObject({ name: "BusinessRegistryAuthorizationError" });

    const wrongAnchor = provider();
    wrongAnchor.getBlock.mockImplementation((blockTag: string | bigint) =>
      Promise.resolve(
        blockTag === 1n
          ? { number: 1, hash: `0x${"ef".repeat(32)}`, timestamp: 1 }
          : { number: 100, hash: HEAD_HASH, timestamp: 1_750_000_000 },
      ),
    );
    await expect(
      getCurrentBusinessRegistryAuthorization(WALLET, wrongAnchor),
    ).rejects.toMatchObject({ name: "BusinessRegistryAuthorizationError" });
    expect(wrongAnchor.send).not.toHaveBeenCalled();

    const reorg = provider();
    let headReads = 0;
    reorg.getBlock.mockImplementation((blockTag: string | bigint) => {
      if (blockTag === 1n)
        return Promise.resolve({
          number: 1,
          hash: `0x${"ab".repeat(32)}`,
          timestamp: 1,
        });
      headReads++;
      return Promise.resolve({
        number: 100,
        hash: headReads === 1 ? HEAD_HASH : `0x${"ee".repeat(32)}`,
        timestamp: 1_750_000_000,
      });
    });
    await expect(
      getCurrentBusinessRegistryAuthorization(WALLET, reorg),
    ).rejects.toMatchObject({ name: "BusinessRegistryAuthorizationError" });

    await expect(
      getCurrentBusinessRegistryAuthorization(
        WALLET,
        provider({ status: 2, active: true }),
      ),
    ).rejects.toMatchObject({ name: "BusinessRegistryAuthorizationError" });
  });
});
