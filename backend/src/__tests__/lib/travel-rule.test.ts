import { Prisma } from "@prisma/client";
import {
  buildCanonicalTravelRulePayload,
  decryptTravelRulePayload,
  encryptTravelRulePayload,
  loadTravelRuleEncryptionConfiguration,
  serializeCanonicalTravelRulePayload,
  TravelRuleDataSchema,
  travelRulePayloadCommitment,
} from "../../lib/travel-rule";

const DATA = {
  originatorName: "Acme Trading LLC",
  originatorAccount: "AE-ORIGINATOR-001",
  originatorAddress: "1 Test Street, Dubai, AE",
  beneficiaryName: "Example Beneficiary Ltd",
  beneficiaryAccount: "GB-BENEFICIARY-002",
  beneficiaryInstitution: "Example VASP",
};

function canonical() {
  return buildCanonicalTravelRulePayload({
    businessId: "biz-1",
    businessAddress: "0x1111111111111111111111111111111111111111",
    payment: {
      id: "11111111-1111-4111-8111-111111111111",
      paymentId: `0x${"ab".repeat(32)}`,
      businessId: "biz-1",
      sender: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: new Prisma.Decimal("1250.00"),
      currency: "USDC",
      purposeHash: `0x${"cd".repeat(32)}`,
      initiatedAt: new Date("2026-07-22T00:00:00.000Z"),
    },
    data: DATA,
  });
}

describe("Travel Rule canonical encryption", () => {
  it("rejects unknown fields, control characters, and oversized UTF-8 data", () => {
    expect(
      TravelRuleDataSchema.safeParse({ ...DATA, unreviewedPii: "secret" })
        .success,
    ).toBe(false);
    expect(
      TravelRuleDataSchema.safeParse({
        ...DATA,
        originatorName: "Acme\u0000Trading",
      }).success,
    ).toBe(false);
    expect(
      TravelRuleDataSchema.safeParse({
        ...DATA,
        originatorAddress: "😀".repeat(200),
      }).success,
    ).toBe(false);
  });

  it("binds the commitment to canonical payment and IVMS101 data", () => {
    const first = serializeCanonicalTravelRulePayload(canonical());
    const changed = serializeCanonicalTravelRulePayload({
      ...canonical(),
      travelRuleData: {
        ...canonical().travelRuleData,
        beneficiary_account: "DIFFERENT",
      },
    });
    expect(travelRulePayloadCommitment(first)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(travelRulePayloadCommitment(first)).not.toBe(
      travelRulePayloadCommitment(changed),
    );
  });

  it("stores no plaintext and authenticates ciphertext, AAD, and key ID", () => {
    const payload = serializeCanonicalTravelRulePayload(canonical());
    const commitment = travelRulePayloadCommitment(payload);
    const configuration = {
      activeKeyId: "key-1",
      keys: new Map([["key-1", Buffer.alloc(32, 7)]]),
    };
    const encrypted = encryptTravelRulePayload({
      canonicalPayload: payload,
      businessId: "biz-1",
      paymentRecordId: "11111111-1111-4111-8111-111111111111",
      payloadCommitment: commitment,
      configuration,
    });
    expect(encrypted.encryptedPayload.toString("utf8")).not.toContain(
      DATA.originatorName,
    );
    expect(
      decryptTravelRulePayload({
        ...encrypted,
        businessId: "biz-1",
        paymentRecordId: "11111111-1111-4111-8111-111111111111",
        payloadCommitment: commitment,
        configuration,
      }),
    ).toBe(payload);
    const tampered = Buffer.from(encrypted.encryptedPayload);
    tampered[0] ^= 1;
    expect(() =>
      decryptTravelRulePayload({
        ...encrypted,
        encryptedPayload: tampered,
        businessId: "biz-1",
        paymentRecordId: "11111111-1111-4111-8111-111111111111",
        payloadCommitment: commitment,
        configuration,
      }),
    ).toThrow();
  });

  it("requires a canonical 32-byte keyring and active key", () => {
    expect(() =>
      loadTravelRuleEncryptionConfiguration({
        TRAVEL_RULE_ACTIVE_KEY_ID: "key-1",
        TRAVEL_RULE_ENCRYPTION_KEYS: JSON.stringify({
          "key-1": Buffer.alloc(32, 3).toString("base64"),
        }),
      }),
    ).not.toThrow();
    expect(() =>
      loadTravelRuleEncryptionConfiguration({
        TRAVEL_RULE_ACTIVE_KEY_ID: "missing",
        TRAVEL_RULE_ENCRYPTION_KEYS: JSON.stringify({
          "key-1": Buffer.alloc(32, 3).toString("base64"),
        }),
      }),
    ).toThrow("not present");
  });
});
