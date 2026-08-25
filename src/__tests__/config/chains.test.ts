jest.unmock("@/config/chains");

const { resolveChainEnvironment, resolveChainId, resolvePublicChainUrl } =
  jest.requireActual<typeof import("@/config/chains")>("@/config/chains");

describe("Aethelred chain configuration", () => {
  it("uses loopback endpoints outside production", () => {
    expect(
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_RPC_URL",
        undefined,
        "https:",
        "http://127.0.0.1:8545",
        "test",
      ),
    ).toBe("http://127.0.0.1:8545");
  });

  it("normalizes an operator-supplied public endpoint", () => {
    expect(
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_RPC_URL",
        "https://rpc.operator.example/",
        "https:",
        "http://127.0.0.1:8545",
        "production",
      ),
    ).toBe("https://rpc.operator.example");
  });

  it.each([
    "not-a-url",
    "file:///tmp/node.sock",
    "https://user:secret@rpc.example",
    "https://rpc.example?token=secret",
    "https://rpc.example/#fragment",
  ])("rejects unsafe public endpoint configuration %s", (value) => {
    expect(() =>
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_RPC_URL",
        value,
        "https:",
        "http://127.0.0.1:8545",
        "test",
      ),
    ).toThrow(/NEXT_PUBLIC_AETHELRED_RPC_URL/);
  });

  it("requires HTTPS and WSS endpoints in production", () => {
    expect(() =>
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_RPC_URL",
        undefined,
        "https:",
        "http://127.0.0.1:8545",
        "production",
      ),
    ).toThrow(/required/);
    expect(() =>
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_RPC_URL",
        "http://rpc.operator.example",
        "https:",
        "http://127.0.0.1:8545",
        "production",
      ),
    ).toThrow(/https/);
    expect(() =>
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_WS_URL",
        "ws://ws.operator.example",
        "wss:",
        "ws://127.0.0.1:8546",
        "production",
      ),
    ).toThrow(/wss/);
  });

  it("allows only known chain environment names", () => {
    expect(resolveChainEnvironment(undefined)).toBe("testnet");
    expect(resolveChainEnvironment("mainnet")).toBe("mainnet");
    expect(() => resolveChainEnvironment("staging")).toThrow(
      /NEXT_PUBLIC_CHAIN_ENV/,
    );
  });

  it("requires an explicit positive safe chain id in production", () => {
    expect(resolveChainId(undefined, "test")).toBe(7332);
    expect(resolveChainId("12345", "production")).toBe(12345);
    expect(() => resolveChainId("", "production")).toThrow(/required/);
    for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(() => resolveChainId(value, "production")).toThrow(
        /positive (?:safe )?integer/,
      );
    }
  });
});

/**
 * The acknowledged plaintext-RPC exception.
 *
 * next.config.js gained this first, but the runtime resolver did not, so a
 * build could pass validation and then throw while collecting page data. Both
 * gates now apply the same conditions; these pin the conditions rather than
 * the fact that an exception exists, because an exception that is easy to
 * trip accidentally is worse than none.
 */
describe("plaintext evaluation RPC", () => {
  const ACK = "acknowledge-evaluation-only-plaintext-rpc";
  const PLAINTEXT = "http://54.165.44.130:8545";
  const original = process.env;

  beforeEach(() => {
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = original;
  });

  const resolve = (allow: boolean) =>
    resolvePublicChainUrl(
      "NEXT_PUBLIC_AETHELRED_RPC_URL",
      PLAINTEXT,
      "https:",
      "http://127.0.0.1:8545",
      "production",
      allow,
    );

  function configure(over: Record<string, string | undefined> = {}) {
    process.env.NEXT_PUBLIC_ALLOW_INSECURE_TESTNET_RPC = ACK;
    process.env.NEXT_PUBLIC_CHAIN_ENV = "testnet";
    process.env.NEXT_PUBLIC_AETHELRED_CHAIN_ID = "7332";
    for (const [k, v] of Object.entries(over)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("accepts a plaintext chain RPC when fully acknowledged", () => {
    configure();
    expect(resolve(true)).toBe(PLAINTEXT);
  });

  it("refuses when the endpoint did not opt in", () => {
    // The site origin and application API pass false; they must never get the
    // exception even with every environment variable set.
    configure();
    expect(() => resolve(false)).toThrow(/must use https in production/u);
  });

  it("refuses without the acknowledgement", () => {
    configure({ NEXT_PUBLIC_ALLOW_INSECURE_TESTNET_RPC: undefined });
    expect(() => resolve(true)).toThrow(/must use https in production/u);
  });

  it("refuses a merely truthy acknowledgement", () => {
    configure({ NEXT_PUBLIC_ALLOW_INSECURE_TESTNET_RPC: "true" });
    expect(() => resolve(true)).toThrow(/must use https in production/u);
  });

  it("refuses outside the testnet environment", () => {
    configure({ NEXT_PUBLIC_CHAIN_ENV: "mainnet" });
    expect(() => resolve(true)).toThrow(/must use https in production/u);
  });

  it("refuses on a chain id other than the public testnet", () => {
    configure({ NEXT_PUBLIC_AETHELRED_CHAIN_ID: "1" });
    expect(() => resolve(true)).toThrow(/must use https in production/u);
  });

  it("still refuses https-only endpoints that are malformed", () => {
    configure();
    expect(() =>
      resolvePublicChainUrl(
        "NEXT_PUBLIC_AETHELRED_RPC_URL",
        "not-a-url",
        "https:",
        "http://127.0.0.1:8545",
        "production",
        true,
      ),
    ).toThrow(/must be a valid absolute URL/u);
  });
});
