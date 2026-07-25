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
    expect(() => resolveChainId(undefined, "production")).toThrow(/required/);
    for (const value of ["0", "-1", "1.5", "9007199254740992"]) {
      expect(() => resolveChainId(value, "production")).toThrow(
        /positive (?:safe )?integer/,
      );
    }
  });
});
