import {
  decimalToSmallestUnits,
  loadNoblePayChainConfiguration,
  parseExternalComplianceUrl,
  parseNetworkAnchorHash,
  parseTokenConfiguration,
} from "../../lib/production-config";

const ANCHOR_HASH = `0x${"ab".repeat(32)}`;
import { collectProductionEnvErrors } from "../../lib/env-validation";

const VALID_ENV: NodeJS.ProcessEnv = {
  JWT_SECRET: "j".repeat(32),
  COMPLIANCE_API_KEY: "c".repeat(32),
  DATABASE_URL: "postgresql://noblepay:secret@db:5432/noblepay",
  AETHELRED_RPC_URL: "https://rpc.testnet.aethelred.network",
  NOBLEPAY_CHAIN_ID: "7332",
  AETHELRED_NETWORK_ANCHOR_BLOCK: "1",
  AETHELRED_NETWORK_ANCHOR_HASH: ANCHOR_HASH,
  NOBLEPAY_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
  BUSINESS_REGISTRY_CONTRACT_ADDRESS:
    "0x2222222222222222222222222222222222222222",
  BUSINESS_VERIFIER_ADDRESS: "0x4444444444444444444444444444444444444444",
  NOBLEPAY_MIN_CONFIRMATIONS: "2",
  NOBLEPAY_TOKEN_CONFIG: JSON.stringify({
    "0x3333333333333333333333333333333333333333": {
      currency: "USDC",
      currencyCode: "USD",
      decimals: 6,
    },
  }),
  COMPLIANCE_API_URL: "https://compliance.aethelred.network",
  COMPLIANCE_MAX_DATASET_AGE_HOURS: "24",
  TRAVEL_RULE_THRESHOLD_USD: "1000.00",
  TRAVEL_RULE_ACTIVE_KEY_ID: "test-key",
  TRAVEL_RULE_ENCRYPTION_KEYS: JSON.stringify({
    "test-key": Buffer.alloc(32, 4).toString("base64"),
  }),
  PUBLIC_ORIGIN: "https://pay.aethelred.network",
  CORS_ORIGIN: "https://pay.aethelred.network",
};

describe("production configuration", () => {
  it("accepts an explicit production configuration", () => {
    expect(collectProductionEnvErrors({ ...VALID_ENV })).toEqual([]);
  });

  it.each([
    "http://compliance.aethelred.network",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.1.2.3",
    "https://mock-compliance.aethelred.network",
    "https://compliance.example.com",
    "https://compliance.aethelred.network/v1",
    "https://compliance.aethelred.network?mode=prod",
    "https://replace-with-compliance-origin",
  ])("rejects non-production compliance origin %s", (url) => {
    expect(() => parseExternalComplianceUrl(url)).toThrow(
      /exact external HTTPS origin/,
    );
  });

  it("rejects weak secrets and zero deployment addresses", () => {
    const errors = collectProductionEnvErrors({
      ...VALID_ENV,
      JWT_SECRET: "short",
      COMPLIANCE_API_KEY: "short",
      NOBLEPAY_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000000",
      BUSINESS_VERIFIER_ADDRESS: "0x0000000000000000000000000000000000000000",
    });
    expect(errors.join(" ")).toMatch(/JWT_SECRET/);
    expect(errors.join(" ")).toMatch(/COMPLIANCE_API_KEY/);
    expect(errors.join(" ")).toMatch(/zero address/);
  });

  it("requires the independent BusinessRegistry verifier identity", () => {
    const missing = { ...VALID_ENV };
    delete missing.BUSINESS_VERIFIER_ADDRESS;
    expect(collectProductionEnvErrors(missing).join(" ")).toMatch(
      /BUSINESS_VERIFIER_ADDRESS/,
    );
  });

  it("requires a non-zero 6-decimal USD stablecoin allowlist", () => {
    expect(() => parseTokenConfiguration("{}")).toThrow(/at least one token/);
    expect(() =>
      parseTokenConfiguration(
        JSON.stringify({
          "0x3333333333333333333333333333333333333333": {
            currency: "AETHEL",
            currencyCode: "AET",
            decimals: 18,
          },
        }),
      ),
    ).toThrow(/USD stablecoin/);
  });

  it("requires and normalizes the immutable network anchor", () => {
    const configuration = loadNoblePayChainConfiguration({ ...VALID_ENV });
    expect(configuration.networkAnchorBlock).toBe(1n);
    expect(
      parseNetworkAnchorHash(ANCHOR_HASH.toUpperCase().replace("0X", "0x")),
    ).toBe(ANCHOR_HASH);

    for (const [name, value] of [
      ["AETHELRED_NETWORK_ANCHOR_BLOCK", "-1"],
      ["AETHELRED_NETWORK_ANCHOR_HASH", "0x1234"],
    ]) {
      const errors = collectProductionEnvErrors({
        ...VALID_ENV,
        [name]: value,
      });
      expect(errors.join(" ")).toMatch(/network anchor|block hash|unsigned/u);
    }
  });

  it("converts decimal values to exact smallest-unit strings without floats", () => {
    expect(decimalToSmallestUnits("12345678901234567890.123456", 6)).toBe(
      "12345678901234567890123456",
    );
    expect(decimalToSmallestUnits("1.2300000", 6)).toBe("1230000");
    expect(() => decimalToSmallestUnits("1.0000001", 6)).toThrow(/precision/);
  });
});
