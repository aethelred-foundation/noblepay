import crypto from "crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { getAddress } from "ethers";
import {
  buildCanonicalTravelRulePayload,
  buildTravelRuleChallengeMessage,
  CanonicalTravelRulePayload,
  configuredTravelRuleThresholdUsd,
  decryptTravelRulePayload,
  encryptTravelRulePayload,
  isTravelRuleChallengeBound,
  isTravelRuleRequired,
  serializeCanonicalTravelRulePayload,
  TravelRuleData,
  travelRulePartyCommitments,
  travelRulePayloadCommitment,
} from "../lib/travel-rule";
import { isCurrentWalletMessageSignatureValid } from "../lib/wallet-signature-authorization";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class TravelRuleError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "TravelRuleError";
  }
}

export interface AuthorizedTravelRulePayload {
  required: true;
  recordId: string;
  payloadCommitment: string;
  data: CanonicalTravelRulePayload["travelRuleData"];
}

export interface TravelRuleRequirement {
  required: boolean;
  authorized: boolean;
  thresholdUsd: string;
  currency: string;
}

function walletAddressOrThrow(
  signerId: string | undefined,
  apiKeyId: string | undefined,
): string {
  if (apiKeyId || !signerId || signerId.startsWith("apikey:")) {
    throw new TravelRuleError(
      "WALLET_SESSION_REQUIRED",
      "A wallet-authenticated session is required to authorize Travel Rule data",
      403,
    );
  }
  try {
    return getAddress(signerId);
  } catch {
    throw new TravelRuleError(
      "WALLET_SESSION_REQUIRED",
      "The authenticated session is not bound to a valid business wallet",
      403,
    );
  }
}

function parseCanonicalPayload(raw: string): CanonicalTravelRulePayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new TravelRuleError(
      "TRAVEL_RULE_RECORD_CORRUPT",
      "Encrypted Travel Rule data could not be decoded",
      503,
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TravelRuleError(
      "TRAVEL_RULE_RECORD_CORRUPT",
      "Encrypted Travel Rule data is invalid",
      503,
    );
  }
  return decoded as CanonicalTravelRulePayload;
}

export class TravelRuleService {
  constructor(private readonly prisma: PrismaClient) {}

  async getRequirement(
    paymentRecordId: string,
    businessId: string,
  ): Promise<TravelRuleRequirement> {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentRecordId, businessId },
      include: { travelRuleRecord: { select: { id: true } } },
    });
    if (!payment) {
      throw new TravelRuleError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }
    let required: boolean;
    try {
      required = isTravelRuleRequired(payment);
    } catch (error) {
      throw new TravelRuleError(
        "TRAVEL_RULE_POLICY_MISCONFIGURED",
        (error as Error).message,
        503,
      );
    }
    return {
      required,
      authorized: required && Boolean(payment.travelRuleRecord),
      thresholdUsd: configuredTravelRuleThresholdUsd().toFixed(2),
      currency: payment.currency,
    };
  }

  async createChallenge(input: {
    paymentRecordId: string;
    data: TravelRuleData;
    businessId: string;
    signerId?: string;
    apiKeyId?: string;
  }): Promise<{
    challengeId: string;
    message: string;
    payloadCommitment: string;
    expiresAt: Date;
  }> {
    const walletAddress = walletAddressOrThrow(input.signerId, input.apiKeyId);
    const payment = await this.prisma.payment.findFirst({
      where: { id: input.paymentRecordId, businessId: input.businessId },
      include: {
        business: { select: { address: true } },
        travelRuleRecord: { select: { id: true } },
      },
    });
    if (!payment) {
      throw new TravelRuleError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }
    if (payment.status !== "PENDING") {
      throw new TravelRuleError(
        "INVALID_STATE",
        `Payment is in ${payment.status} state, expected PENDING`,
        409,
      );
    }
    if (payment.travelRuleRecord) {
      throw new TravelRuleError(
        "TRAVEL_RULE_ALREADY_AUTHORIZED",
        "Travel Rule data has already been authorized for this payment",
        409,
      );
    }
    if (!isTravelRuleRequired(payment)) {
      throw new TravelRuleError(
        "TRAVEL_RULE_NOT_REQUIRED",
        "This payment is below the configured Travel Rule threshold",
        409,
      );
    }
    if (
      walletAddress.toLowerCase() !== payment.business.address.toLowerCase()
    ) {
      throw new TravelRuleError(
        "WALLET_TENANT_MISMATCH",
        "The signing wallet is not the authenticated tenant business wallet",
        403,
      );
    }

    const canonical = buildCanonicalTravelRulePayload({
      businessId: input.businessId,
      businessAddress: payment.business.address,
      payment,
      data: input.data,
    });
    const payloadCommitment = travelRulePayloadCommitment(
      serializeCanonicalTravelRulePayload(canonical),
    );
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(16).toString("hex");
    const message = buildTravelRuleChallengeMessage({
      address: walletAddress,
      nonce,
      issuedAt,
      expiresAt,
      challengeId,
      paymentId: payment.paymentId,
      payloadCommitment,
    });
    const challenge = await this.prisma.walletChallenge.create({
      data: {
        id: challengeId,
        address: walletAddress,
        nonce,
        message,
        purpose: "TRAVEL_RULE",
        travelRulePaymentId: payment.id,
        travelRuleCommitment: payloadCommitment,
        expiresAt,
      },
      select: { id: true, message: true, expiresAt: true },
    });
    return {
      challengeId: challenge.id,
      message: challenge.message,
      payloadCommitment,
      expiresAt: challenge.expiresAt,
    };
  }

  async authorize(input: {
    paymentRecordId: string;
    challengeId: string;
    signature: string;
    data: TravelRuleData;
    businessId: string;
    signerId?: string;
    apiKeyId?: string;
  }): Promise<{ payloadCommitment: string; authorizedBy: string }> {
    const walletAddress = walletAddressOrThrow(input.signerId, input.apiKeyId);
    const [payment, challenge] = await Promise.all([
      this.prisma.payment.findFirst({
        where: { id: input.paymentRecordId, businessId: input.businessId },
        include: {
          business: { select: { address: true } },
          travelRuleRecord: true,
        },
      }),
      this.prisma.walletChallenge.findUnique({
        where: { id: input.challengeId },
      }),
    ]);
    if (!payment) {
      throw new TravelRuleError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }
    if (
      walletAddress.toLowerCase() !== payment.business.address.toLowerCase()
    ) {
      throw new TravelRuleError(
        "WALLET_TENANT_MISMATCH",
        "The signing wallet is not the authenticated tenant business wallet",
        403,
      );
    }

    const canonical = buildCanonicalTravelRulePayload({
      businessId: input.businessId,
      businessAddress: payment.business.address,
      payment,
      data: input.data,
    });
    const canonicalPayload = serializeCanonicalTravelRulePayload(canonical);
    const payloadCommitment = travelRulePayloadCommitment(canonicalPayload);
    if (
      !challenge ||
      challenge.purpose !== "TRAVEL_RULE" ||
      challenge.address.toLowerCase() !== walletAddress.toLowerCase() ||
      challenge.travelRulePaymentId !== payment.id ||
      challenge.travelRuleCommitment?.toLowerCase() !== payloadCommitment ||
      !isTravelRuleChallengeBound(challenge.message, {
        paymentId: payment.paymentId,
        payloadCommitment,
      })
    ) {
      throw new TravelRuleError(
        "INVALID_TRAVEL_RULE_CHALLENGE",
        "Travel Rule challenge does not match this tenant, payment, or data commitment",
        401,
      );
    }

    let signatureValid: boolean;
    try {
      signatureValid = await isCurrentWalletMessageSignatureValid(
        walletAddress,
        challenge.message,
        input.signature,
      );
    } catch {
      throw new TravelRuleError(
        "TRAVEL_RULE_SIGNATURE_VERIFICATION_UNAVAILABLE",
        "Travel Rule wallet signature could not be verified on the configured canonical chain",
        503,
      );
    }
    if (!signatureValid) {
      throw new TravelRuleError(
        "INVALID_TRAVEL_RULE_SIGNATURE",
        "Travel Rule wallet signature does not match the tenant business wallet",
        401,
      );
    }

    if (
      payment.travelRuleRecord?.challengeId === challenge.id &&
      payment.travelRuleRecord.payloadCommitment.toLowerCase() ===
        payloadCommitment
    ) {
      return { payloadCommitment, authorizedBy: walletAddress };
    }
    if (payment.travelRuleRecord) {
      throw new TravelRuleError(
        "TRAVEL_RULE_COMMITMENT_CONFLICT",
        "Different Travel Rule data is already bound to this payment",
        409,
      );
    }
    if (challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) {
      throw new TravelRuleError(
        "INVALID_TRAVEL_RULE_CHALLENGE",
        "Travel Rule challenge is expired or already used",
        401,
      );
    }

    const encrypted = encryptTravelRulePayload({
      canonicalPayload,
      businessId: input.businessId,
      paymentRecordId: payment.id,
      payloadCommitment,
    });
    const partyCommitments = travelRulePartyCommitments(canonical);

    await this.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.payment.findFirst({
          where: {
            id: payment.id,
            businessId: input.businessId,
            status: "PENDING",
          },
          include: { travelRuleRecord: true },
        });
        if (!current) {
          throw new TravelRuleError(
            "PAYMENT_STATE_CHANGED",
            "Payment state changed before Travel Rule authorization",
            409,
          );
        }
        if (current.travelRuleRecord) {
          if (
            current.travelRuleRecord.challengeId === challenge.id &&
            current.travelRuleRecord.payloadCommitment.toLowerCase() ===
              payloadCommitment
          ) {
            return;
          }
          throw new TravelRuleError(
            "TRAVEL_RULE_COMMITMENT_CONFLICT",
            "Different Travel Rule data is already bound to this payment",
            409,
          );
        }
        const consumed = await transaction.walletChallenge.updateMany({
          where: {
            id: challenge.id,
            purpose: "TRAVEL_RULE",
            usedAt: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedAt: new Date() },
        });
        if (consumed.count !== 1) {
          throw new TravelRuleError(
            "TRAVEL_RULE_CHALLENGE_REPLAYED",
            "Travel Rule challenge has already been consumed",
            409,
          );
        }
        await transaction.travelRuleRecord.create({
          data: {
            paymentId: payment.paymentId,
            originatorHash: partyCommitments.originatorHash,
            beneficiaryHash: partyCommitments.beneficiaryHash,
            amount: payment.amount,
            currency: payment.currency,
            payloadCommitment,
            encryptedPayload: encrypted.encryptedPayload,
            encryptionIv: encrypted.encryptionIv,
            authenticationTag: encrypted.authenticationTag,
            encryptionKeyId: encrypted.encryptionKeyId,
            authorizedBy: walletAddress,
            authorizationSignature: input.signature.toLowerCase(),
            challengeId: challenge.id,
            outboundAttemptCount: 0,
            shared: false,
            sharedWith: [],
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { payloadCommitment, authorizedBy: walletAddress };
  }

  /**
   * Durably record the possibility of disclosure before cleartext crosses the
   * TLS boundary. This is deliberately conservative: a crash after this commit
   * but before the socket write leaves an attempt record, never an unrecorded
   * disclosure. The verified `shared` flag remains false until chain proof is
   * committed with the screening.
   */
  async recordOutboundAttempt(input: {
    paymentRecordId: string;
    businessId: string;
    recordId: string;
    payloadCommitment: string;
    requestId: string;
    destination: string;
  }): Promise<void> {
    let destination: string;
    try {
      const parsed = new URL(input.destination);
      if (parsed.protocol !== "https:" || parsed.origin !== input.destination)
        throw new Error("invalid origin");
      destination = parsed.origin;
    } catch {
      throw new TravelRuleError(
        "TRAVEL_RULE_DESTINATION_INVALID",
        "Travel Rule destination must be an exact HTTPS origin",
        503,
      );
    }

    await this.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.travelRuleRecord.findFirst({
          where: {
            id: input.recordId,
            payloadCommitment: input.payloadCommitment,
            payment: {
              id: input.paymentRecordId,
              businessId: input.businessId,
            },
          },
        });
        if (!current || current.shared) {
          throw new TravelRuleError(
            "TRAVEL_RULE_ATTEMPT_STATE_INVALID",
            "Travel Rule record is unavailable for a new outbound attempt",
            409,
          );
        }
        if (
          current.outboundAttemptCount < 0 ||
          (current.outboundAttemptCount === 0 &&
            (current.outboundRequestId ||
              current.outboundDestination ||
              current.firstOutboundAttemptAt ||
              current.lastOutboundAttemptAt)) ||
          (current.outboundAttemptCount > 0 &&
            (current.outboundRequestId !== input.requestId ||
              current.outboundDestination !== destination ||
              !current.firstOutboundAttemptAt ||
              !current.lastOutboundAttemptAt))
        ) {
          throw new TravelRuleError(
            "TRAVEL_RULE_ATTEMPT_STATE_CORRUPT",
            "Travel Rule outbound attempt metadata is inconsistent",
            503,
          );
        }
        const now = new Date();
        const updated = await transaction.travelRuleRecord.updateMany({
          where: {
            id: current.id,
            payloadCommitment: input.payloadCommitment,
            shared: false,
            outboundAttemptCount: current.outboundAttemptCount,
          },
          data: {
            outboundRequestId: input.requestId,
            outboundDestination: destination,
            outboundAttemptCount: { increment: 1 },
            firstOutboundAttemptAt: current.firstOutboundAttemptAt || now,
            lastOutboundAttemptAt: now,
          },
        });
        if (updated.count !== 1) {
          throw new TravelRuleError(
            "TRAVEL_RULE_ATTEMPT_RACE",
            "A concurrent Travel Rule outbound attempt changed the record; retry safely",
            409,
          );
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async loadAuthorizedPayload(payment: {
    id: string;
    paymentId: string;
    businessId: string;
    sender: string;
    recipient: string;
    amount: { toString(): string };
    currency: string;
    purposeHash: string | null;
    initiatedAt: Date;
  }): Promise<AuthorizedTravelRulePayload | { required: false; data: null }> {
    let required: boolean;
    try {
      required = isTravelRuleRequired(payment);
    } catch (error) {
      throw new TravelRuleError(
        "TRAVEL_RULE_POLICY_MISCONFIGURED",
        (error as Error).message,
        503,
      );
    }
    if (!required) return { required: false, data: null };

    const [business, record] = await Promise.all([
      this.prisma.business.findUnique({
        where: { id: payment.businessId },
        select: { address: true },
      }),
      this.prisma.travelRuleRecord.findFirst({
        where: {
          paymentId: payment.paymentId,
          payment: { businessId: payment.businessId },
        },
        include: { challenge: true },
      }),
    ]);
    if (!business || !record) {
      throw new TravelRuleError(
        "TRAVEL_RULE_DATA_REQUIRED",
        "Wallet-authorized Travel Rule data is required before screening this payment",
        422,
      );
    }
    if (record.authorizedBy.toLowerCase() !== business.address.toLowerCase()) {
      throw new TravelRuleError(
        "TRAVEL_RULE_RECORD_CORRUPT",
        "Travel Rule authorization does not match the tenant business wallet",
        503,
      );
    }
    let storedAuthorizationValid: boolean;
    try {
      if (
        record.challenge.purpose !== "TRAVEL_RULE" ||
        !record.challenge.usedAt ||
        record.challenge.address.toLowerCase() !==
          record.authorizedBy.toLowerCase() ||
        record.challenge.travelRulePaymentId !== payment.id ||
        record.challenge.travelRuleCommitment?.toLowerCase() !==
          record.payloadCommitment.toLowerCase() ||
        !isTravelRuleChallengeBound(record.challenge.message, {
          paymentId: payment.paymentId,
          payloadCommitment: record.payloadCommitment,
        })
      ) {
        throw new Error("challenge mismatch");
      }
      storedAuthorizationValid = await isCurrentWalletMessageSignatureValid(
        record.authorizedBy,
        record.challenge.message,
        record.authorizationSignature,
      );
    } catch {
      throw new TravelRuleError(
        "TRAVEL_RULE_AUTHORIZATION_CORRUPT",
        "Stored Travel Rule wallet authorization failed cryptographic verification",
        503,
      );
    }
    if (!storedAuthorizationValid) {
      throw new TravelRuleError(
        "TRAVEL_RULE_AUTHORIZATION_CORRUPT",
        "Stored Travel Rule signature does not match the tenant business wallet",
        503,
      );
    }

    let canonicalPayload: string;
    try {
      canonicalPayload = decryptTravelRulePayload({
        encryptedPayload: Buffer.from(record.encryptedPayload),
        encryptionIv: Buffer.from(record.encryptionIv),
        authenticationTag: Buffer.from(record.authenticationTag),
        encryptionKeyId: record.encryptionKeyId,
        businessId: payment.businessId,
        paymentRecordId: payment.id,
        payloadCommitment: record.payloadCommitment,
      });
    } catch {
      throw new TravelRuleError(
        "TRAVEL_RULE_DECRYPTION_FAILED",
        "Encrypted Travel Rule data failed authentication",
        503,
      );
    }
    const decoded = parseCanonicalPayload(canonicalPayload);
    const rawData = decoded.travelRuleData;
    const data: TravelRuleData = {
      originatorName: rawData?.originator_name,
      originatorAccount: rawData?.originator_account,
      originatorAddress: rawData?.originator_address,
      beneficiaryName: rawData?.beneficiary_name,
      beneficiaryAccount: rawData?.beneficiary_account,
      ...(rawData?.originator_id
        ? { originatorNationalId: rawData.originator_id }
        : {}),
      ...(rawData?.beneficiary_institution
        ? { beneficiaryInstitution: rawData.beneficiary_institution }
        : {}),
    };
    let expected: CanonicalTravelRulePayload;
    try {
      expected = buildCanonicalTravelRulePayload({
        businessId: payment.businessId,
        businessAddress: business.address,
        payment,
        data,
      });
    } catch {
      throw new TravelRuleError(
        "TRAVEL_RULE_RECORD_CORRUPT",
        "Encrypted Travel Rule payload failed canonical validation",
        503,
      );
    }
    const expectedCanonical = serializeCanonicalTravelRulePayload(expected);
    const expectedCommitment = travelRulePayloadCommitment(expectedCanonical);
    const partyCommitments = travelRulePartyCommitments(expected);
    if (
      canonicalPayload !== expectedCanonical ||
      record.payloadCommitment.toLowerCase() !== expectedCommitment ||
      record.originatorHash.toLowerCase() !== partyCommitments.originatorHash ||
      record.beneficiaryHash.toLowerCase() !==
        partyCommitments.beneficiaryHash ||
      new Prisma.Decimal(record.amount.toString()).toFixed() !==
        expected.payment.amount ||
      record.currency.toUpperCase() !== expected.payment.currency
    ) {
      throw new TravelRuleError(
        "TRAVEL_RULE_RECORD_CORRUPT",
        "Travel Rule record no longer matches its payment-bound commitment",
        503,
      );
    }
    return {
      required: true,
      recordId: record.id,
      payloadCommitment: expectedCommitment,
      data: expected.travelRuleData,
    };
  }
}
