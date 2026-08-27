import { Interface, Wallet, hashMessage } from "ethers";
import { isCurrentWalletMessageSignatureValid } from "../../lib/wallet-signature-authorization";

const REGISTRY = "0x1111111111111111111111111111111111111111";
const NOBLEPAY = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const SAFE = "0x4444444444444444444444444444444444444444";
const HEAD_HASH = `0x${"cd".repeat(32)}`;
const MESSAGE = "NoblePay wallet challenge\nDomain: noblepay.test";
const SIGNATURE = `0x${"12".repeat(65)}`;
const eip1271 = new Interface([
  "function isValidSignature(bytes32 hash,bytes signature) view returns (bytes4 magicValue)",
]);

describe("wallet signature authorization", () => {
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

  function provider(code: string, magic = "0x1626ba7e") {
    const call = jest
      .fn()
      .mockResolvedValue(
        eip1271.encodeFunctionResult("isValidSignature", [magic]),
      );
    return {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 7332n }),
      getBlock: jest
        .fn()
        .mockImplementation((blockTag: string | bigint) =>
          Promise.resolve(
            blockTag === 1n
              ? { number: 1, hash: `0x${"ab".repeat(32)}` }
              : { number: 100, hash: HEAD_HASH },
          ),
        ),
      getCode: jest.fn().mockResolvedValue(code),
      call,
      send: jest.fn((_method: string, [request]: [unknown]) => call(request)),
    } as any;
  }

  it("preserves EOA EIP-191 signature verification at the canonical block", async () => {
    const wallet = Wallet.createRandom();
    const signature = await wallet.signMessage(MESSAGE);
    const rpc = provider("0x");
    await expect(
      isCurrentWalletMessageSignatureValid(
        wallet.address,
        MESSAGE,
        signature,
        rpc,
      ),
    ).resolves.toBe(true);
    expect(rpc.send).not.toHaveBeenCalled();
    expect(rpc.getCode).toHaveBeenCalledWith(wallet.address, 100);
  });

  it("accepts a Safe-style EIP-1271 magic-value response at the pinned block", async () => {
    const rpc = provider("0x6000");
    await expect(
      isCurrentWalletMessageSignatureValid(SAFE, MESSAGE, SIGNATURE, rpc),
    ).resolves.toBe(true);
    const expectedData = eip1271.encodeFunctionData("isValidSignature", [
      hashMessage(MESSAGE),
      SIGNATURE,
    ]);
    expect(rpc.send).toHaveBeenCalledWith("eth_call", [
      { to: SAFE, data: expectedData },
      "0x64",
    ]);
  });

  it("rejects EIP-1271 bad magic and fails closed on revert", async () => {
    await expect(
      isCurrentWalletMessageSignatureValid(
        SAFE,
        MESSAGE,
        SIGNATURE,
        provider("0x6000", "0xffffffff"),
      ),
    ).resolves.toBe(false);

    const reverted = provider("0x6000");
    reverted.send.mockRejectedValue(new Error("execution reverted"));
    await expect(
      isCurrentWalletMessageSignatureValid(SAFE, MESSAGE, SIGNATURE, reverted),
    ).rejects.toMatchObject({ name: "WalletSignatureAuthorizationError" });
  });

  it("fails closed when the signature-validation head is reorged", async () => {
    const rpc = provider("0x6000");
    let headReads = 0;
    rpc.getBlock.mockImplementation((blockTag: string | bigint) => {
      if (blockTag === 1n)
        return Promise.resolve({ number: 1, hash: `0x${"ab".repeat(32)}` });
      headReads++;
      return Promise.resolve({
        number: 100,
        hash: headReads === 1 ? HEAD_HASH : `0x${"ef".repeat(32)}`,
      });
    });
    await expect(
      isCurrentWalletMessageSignatureValid(SAFE, MESSAGE, SIGNATURE, rpc),
    ).rejects.toMatchObject({ name: "WalletSignatureAuthorizationError" });
  });

  it("fails closed when the immutable anchor drifts after EIP-1271 validation", async () => {
    const rpc = provider("0x6000");
    let anchorReads = 0;
    rpc.getBlock.mockImplementation((blockTag: string | bigint) => {
      if (blockTag === 1n) {
        anchorReads += 1;
        return Promise.resolve({
          number: 1,
          hash:
            anchorReads === 1 ? `0x${"ab".repeat(32)}` : `0x${"ef".repeat(32)}`,
        });
      }
      return Promise.resolve({ number: 100, hash: HEAD_HASH });
    });

    await expect(
      isCurrentWalletMessageSignatureValid(SAFE, MESSAGE, SIGNATURE, rpc),
    ).rejects.toMatchObject({ name: "WalletSignatureAuthorizationError" });
  });
});
