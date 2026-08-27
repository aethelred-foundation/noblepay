import { Prisma } from "@prisma/client";
import { Wallet } from "ethers";
import { isCurrentWalletMessageSignatureValid } from "../../lib/wallet-signature-authorization";
import { TravelRuleService } from "../../services/travel-rule";

jest.mock("../../lib/wallet-signature-authorization", () => ({
  isCurrentWalletMessageSignatureValid: jest.fn(),
}));

const verifyWalletSignature =
  isCurrentWalletMessageSignatureValid as jest.MockedFunction<
    typeof isCurrentWalletMessageSignatureValid
  >;

const PAYMENT_DB_ID = "11111111-1111-4111-8111-111111111111";
const PAYMENT_ID = `0x${"ab".repeat(32)}`;
const DATA = {
  originatorName: "Acme Trading LLC",
  originatorAccount: "AE-ORIGINATOR-001",
  originatorAddress: "1 Test Street, Dubai, AE",
  beneficiaryName: "Example Beneficiary Ltd",
  beneficiaryAccount: "GB-BENEFICIARY-002",
};

describe("TravelRuleService", () => {
  const saved: NodeJS.ProcessEnv = {};
  let tenantWallet: ReturnType<typeof Wallet.createRandom>;
  let otherWallet: ReturnType<typeof Wallet.createRandom>;
  let payment: any;
  let challenges: Map<string, any>;
  let record: any;
  let prisma: any;
  let service: TravelRuleService;

  beforeAll(() => {
    for (const key of [
      "TRAVEL_RULE_THRESHOLD_USD",
      "TRAVEL_RULE_ACTIVE_KEY_ID",
      "TRAVEL_RULE_ENCRYPTION_KEYS",
      "PUBLIC_ORIGIN",
      "NOBLEPAY_CHAIN_ID",
    ])
      saved[key] = process.env[key];
  });

  beforeEach(() => {
    verifyWalletSignature.mockReset().mockResolvedValue(true);
    process.env.TRAVEL_RULE_THRESHOLD_USD = "1000.00";
    process.env.TRAVEL_RULE_ACTIVE_KEY_ID = "test-key";
    process.env.TRAVEL_RULE_ENCRYPTION_KEYS = JSON.stringify({
      "test-key": Buffer.alloc(32, 9).toString("base64"),
    });
    process.env.PUBLIC_ORIGIN = "http://localhost:3008";
    process.env.NOBLEPAY_CHAIN_ID = "7332";
    tenantWallet = Wallet.createRandom();
    otherWallet = Wallet.createRandom();
    challenges = new Map();
    record = null;
    payment = {
      id: PAYMENT_DB_ID,
      paymentId: PAYMENT_ID,
      businessId: "biz-1",
      business: { address: tenantWallet.address },
      sender: tenantWallet.address,
      recipient: "0x2222222222222222222222222222222222222222",
      amount: new Prisma.Decimal("1250"),
      currency: "USDC",
      purposeHash: `0x${"cd".repeat(32)}`,
      status: "PENDING",
      initiatedAt: new Date("2026-07-22T00:00:00.000Z"),
    };

    const paymentModel = {
      findFirst: jest.fn(({ where }: any) => {
        if (
          where.id !== PAYMENT_DB_ID ||
          where.businessId !== "biz-1" ||
          (where.status && where.status !== payment.status)
        )
          return null;
        return { ...payment, travelRuleRecord: record };
      }),
    };
    const challengeModel = {
      create: jest.fn(({ data }: any) => {
        const value = { ...data, usedAt: null };
        challenges.set(data.id, value);
        return value;
      }),
      findUnique: jest.fn(({ where }: any) => challenges.get(where.id) || null),
      updateMany: jest.fn(({ where, data }: any) => {
        const value = challenges.get(where.id);
        if (!value || value.usedAt || value.expiresAt <= new Date())
          return { count: 0 };
        challenges.set(where.id, { ...value, ...data });
        return { count: 1 };
      }),
    };
    const recordModel = {
      create: jest.fn(({ data }: any) => {
        record = { id: "travel-1", createdAt: new Date(), ...data };
        return record;
      }),
      findFirst: jest.fn(({ where }: any) =>
        record &&
        (!where.id || where.id === record.id) &&
        (!where.paymentId || where.paymentId === PAYMENT_ID) &&
        where.payment.businessId === "biz-1" &&
        (!where.payment.id || where.payment.id === PAYMENT_DB_ID)
          ? { ...record, challenge: challenges.get(record.challengeId) }
          : null,
      ),
      updateMany: jest.fn(({ where, data }: any) => {
        if (
          !record ||
          where.id !== record.id ||
          where.outboundAttemptCount !== record.outboundAttemptCount
        )
          return { count: 0 };
        record = {
          ...record,
          ...data,
          outboundAttemptCount:
            record.outboundAttemptCount +
            (data.outboundAttemptCount?.increment || 0),
        };
        return { count: 1 };
      }),
    };
    prisma = {
      payment: paymentModel,
      business: {
        findUnique: jest.fn(({ where }: any) =>
          where.id === "biz-1" ? { address: tenantWallet.address } : null,
        ),
      },
      walletChallenge: challengeModel,
      travelRuleRecord: recordModel,
      $transaction: jest.fn(async (callback: (database: any) => unknown) =>
        callback({
          payment: paymentModel,
          walletChallenge: challengeModel,
          travelRuleRecord: recordModel,
        }),
      ),
    };
    service = new TravelRuleService(prisma);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function authorize() {
    const challenge = await service.createChallenge({
      paymentRecordId: PAYMENT_DB_ID,
      data: DATA,
      businessId: "biz-1",
      signerId: tenantWallet.address,
    });
    const signature = await tenantWallet.signMessage(challenge.message);
    await service.authorize({
      paymentRecordId: PAYMENT_DB_ID,
      challengeId: challenge.challengeId,
      signature,
      data: DATA,
      businessId: "biz-1",
      signerId: tenantWallet.address,
    });
    return { challenge, signature };
  }

  it("tenant-scopes requirement lookup and reports exact threshold behavior", async () => {
    await expect(
      service.getRequirement(PAYMENT_DB_ID, "other-biz"),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", statusCode: 404 });
    await expect(
      service.getRequirement(PAYMENT_DB_ID, "biz-1"),
    ).resolves.toEqual({
      required: true,
      authorized: false,
      thresholdUsd: "1000.00",
      currency: "USDC",
    });
    await expect(service.loadAuthorizedPayload(payment)).rejects.toMatchObject({
      code: "TRAVEL_RULE_DATA_REQUIRED",
      statusCode: 422,
    });
    payment.amount = new Prisma.Decimal("999.99");
    await expect(
      service.getRequirement(PAYMENT_DB_ID, "biz-1"),
    ).resolves.toMatchObject({ required: false });
  });

  it("requires the tenant wallet and rejects signature mismatch and payload tampering", async () => {
    await expect(
      service.createChallenge({
        paymentRecordId: PAYMENT_DB_ID,
        data: DATA,
        businessId: "biz-1",
        signerId: "apikey:key-1",
        apiKeyId: "key-1",
      }),
    ).rejects.toMatchObject({ code: "WALLET_SESSION_REQUIRED" });

    const challenge = await service.createChallenge({
      paymentRecordId: PAYMENT_DB_ID,
      data: DATA,
      businessId: "biz-1",
      signerId: tenantWallet.address,
    });
    verifyWalletSignature.mockResolvedValueOnce(false);
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: challenge.challengeId,
        signature: await otherWallet.signMessage(challenge.message),
        data: DATA,
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRAVEL_RULE_SIGNATURE" });
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: challenge.challengeId,
        signature: await tenantWallet.signMessage(challenge.message),
        data: { ...DATA, beneficiaryAccount: "TAMPERED" },
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRAVEL_RULE_CHALLENGE" });
    expect(record).toBeNull();
  });

  it("persists ciphertext only and decrypts the identical outbound payload", async () => {
    await authorize();
    const persisted = prisma.travelRuleRecord.create.mock.calls[0][0].data;
    expect(Buffer.isBuffer(persisted.encryptedPayload)).toBe(true);
    expect(persisted.encryptedPayload.toString("utf8")).not.toContain(
      DATA.originatorName,
    );
    expect(JSON.stringify(persisted)).not.toContain(DATA.originatorName);
    await expect(service.loadAuthorizedPayload(payment)).resolves.toMatchObject(
      {
        required: true,
        recordId: "travel-1",
        data: {
          originator_name: DATA.originatorName,
          beneficiary_account: DATA.beneficiaryAccount,
        },
      },
    );
    record.authorizationSignature = `0x${"00".repeat(65)}`;
    verifyWalletSignature.mockResolvedValueOnce(false);
    await expect(service.loadAuthorizedPayload(payment)).rejects.toMatchObject({
      code: "TRAVEL_RULE_AUTHORIZATION_CORRUPT",
    });
  });

  it("accepts a Safe contract signature through the anchored shared verifier", async () => {
    const challenge = await service.createChallenge({
      paymentRecordId: PAYMENT_DB_ID,
      data: DATA,
      businessId: "biz-1",
      signerId: tenantWallet.address,
    });
    const safeSignature = `0x${"12".repeat(130)}`;
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: challenge.challengeId,
        signature: safeSignature,
        data: DATA,
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).resolves.toMatchObject({ authorizedBy: tenantWallet.address });
    expect(record.authorizationSignature).toBe(safeSignature);
    expect(verifyWalletSignature).toHaveBeenCalledWith(
      tenantWallet.address,
      challenge.message,
      safeSignature,
    );
  });

  it("rejects EIP-1271 bad magic and fails closed on canonical RPC drift", async () => {
    const badMagicChallenge = await service.createChallenge({
      paymentRecordId: PAYMENT_DB_ID,
      data: DATA,
      businessId: "biz-1",
      signerId: tenantWallet.address,
    });
    verifyWalletSignature.mockResolvedValueOnce(false);
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: badMagicChallenge.challengeId,
        signature: "0x1234",
        data: DATA,
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TRAVEL_RULE_SIGNATURE",
      statusCode: 401,
    });

    const driftChallenge = await service.createChallenge({
      paymentRecordId: PAYMENT_DB_ID,
      data: DATA,
      businessId: "biz-1",
      signerId: tenantWallet.address,
    });
    verifyWalletSignature.mockRejectedValueOnce(new Error("canonical drift"));
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: driftChallenge.challengeId,
        signature: "0x1234",
        data: DATA,
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).rejects.toMatchObject({
      code: "TRAVEL_RULE_SIGNATURE_VERIFICATION_UNAVAILABLE",
      statusCode: 503,
    });
    expect(record).toBeNull();
  });

  it("durably records every possible disclosure before verified sharing", async () => {
    await authorize();
    await service.recordOutboundAttempt({
      paymentRecordId: PAYMENT_DB_ID,
      businessId: "biz-1",
      recordId: record.id,
      payloadCommitment: record.payloadCommitment,
      requestId: PAYMENT_DB_ID,
      destination: "https://compliance.aethelred.network",
    });
    const firstAttempt = record.firstOutboundAttemptAt;
    expect(record).toMatchObject({
      shared: false,
      outboundAttemptCount: 1,
      outboundRequestId: PAYMENT_DB_ID,
      outboundDestination: "https://compliance.aethelred.network",
      firstOutboundAttemptAt: expect.any(Date),
      lastOutboundAttemptAt: expect.any(Date),
    });
    await service.recordOutboundAttempt({
      paymentRecordId: PAYMENT_DB_ID,
      businessId: "biz-1",
      recordId: record.id,
      payloadCommitment: record.payloadCommitment,
      requestId: PAYMENT_DB_ID,
      destination: "https://compliance.aethelred.network",
    });
    expect(record.outboundAttemptCount).toBe(2);
    expect(record.firstOutboundAttemptAt).toBe(firstAttempt);
    expect(record.shared).toBe(false);
  });

  it("consumes a challenge once while making the exact completed retry idempotent", async () => {
    const { challenge, signature } = await authorize();
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: challenge.challengeId,
        signature,
        data: DATA,
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).resolves.toMatchObject({ authorizedBy: tenantWallet.address });
    expect(prisma.travelRuleRecord.create).toHaveBeenCalledTimes(1);

    record.challengeId = "different-challenge";
    await expect(
      service.authorize({
        paymentRecordId: PAYMENT_DB_ID,
        challengeId: challenge.challengeId,
        signature,
        data: DATA,
        businessId: "biz-1",
        signerId: tenantWallet.address,
      }),
    ).rejects.toMatchObject({ code: "TRAVEL_RULE_COMMITMENT_CONFLICT" });
  });
});
