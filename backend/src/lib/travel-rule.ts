import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";
import {
  resolveWalletRelyingParty,
  WalletRelyingParty,
} from "./wallet-challenge";

const TRAVEL_RULE_MESSAGE_PURPOSE = "- urn:noblepay:purpose:travel-rule";
const TRAVEL_RULE_PAYMENT_PREFIX = "- urn:noblepay:payment:";
const TRAVEL_RULE_COMMITMENT_PREFIX = "- urn:noblepay:travel-rule-commitment:";
const ENCRYPTION_DOMAIN = "noblepay:travel-rule:aes-256-gcm:v1";
const COMMITMENT_DOMAIN = "noblepay:travel-rule:ivms101:v1";

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function boundedPrivateString(label: string, maximumBytes: number) {
  return z
    .string()
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(
      z
        .string()
        .min(1, `${label} is required`)
        .max(maximumBytes, `${label} is too long`)
        .refine(
          (value) => Buffer.byteLength(value, "utf8") <= maximumBytes,
          `${label} must not exceed ${maximumBytes} UTF-8 bytes`,
        )
        .refine(
          (value) => !containsControlCharacter(value),
          `${label} must not contain control characters`,
        ),
    );
}

/**
 * A deliberately small IVMS101 subset. These are the five fields the
 * reference verifier actually requires, plus the two optional identifiers it
 * knows how to transmit. Unknown fields are rejected instead of being silently
 * persisted as unreviewed PII.
 */
export const TravelRuleDataSchema = z
  .object({
    originatorName: boundedPrivateString("Originator legal name", 200),
    originatorAccount: boundedPrivateString("Originator account", 128),
    originatorAddress: boundedPrivateString("Originator address", 512),
    beneficiaryName: boundedPrivateString("Beneficiary legal name", 200),
    beneficiaryAccount: boundedPrivateString("Beneficiary account", 128),
    originatorNationalId: boundedPrivateString(
      "Originator national or registration ID",
      128,
    ).optional(),
    beneficiaryInstitution: boundedPrivateString(
      "Beneficiary institution",
      200,
    ).optional(),
  })
  .strict();

export type TravelRuleData = z.infer<typeof TravelRuleDataSchema>;

export interface CanonicalTravelRulePayload {
  version: "NOBLEPAY_IVMS101_V1";
  business: {
    id: string;
    address: string;
  };
  payment: {
    recordId: string;
    paymentId: string;
    sender: string;
    recipient: string;
    amount: string;
    currency: string;
    purposeHash: string | null;
    initiatedAt: string;
  };
  travelRuleData: {
    originator_name: string;
    originator_account: string;
    originator_address: string;
    beneficiary_name: string;
    beneficiary_account: string;
    originator_id?: string;
    beneficiary_institution?: string;
  };
}

export interface TravelRulePaymentBinding {
  id: string;
  paymentId: string;
  businessId: string;
  sender: string;
  recipient: string;
  amount: { toString(): string };
  currency: string;
  purposeHash: string | null;
  initiatedAt: Date;
}

export interface TravelRuleEncryptionConfiguration {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

function canonicalDecimal(raw: string): string {
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(raw);
  } catch {
    throw new Error("Payment amount is not a valid decimal");
  }
  if (!value.isPositive()) throw new Error("Payment amount must be positive");
  return value.toFixed();
}

export function buildCanonicalTravelRulePayload(input: {
  businessId: string;
  businessAddress: string;
  payment: TravelRulePaymentBinding;
  data: TravelRuleData;
}): CanonicalTravelRulePayload {
  const data = TravelRuleDataSchema.parse(input.data);
  return {
    version: "NOBLEPAY_IVMS101_V1",
    business: {
      id: input.businessId,
      address: getAddress(input.businessAddress),
    },
    payment: {
      recordId: input.payment.id,
      paymentId: input.payment.paymentId.toLowerCase(),
      sender: getAddress(input.payment.sender),
      recipient: getAddress(input.payment.recipient),
      amount: canonicalDecimal(input.payment.amount.toString()),
      currency: input.payment.currency.trim().toUpperCase(),
      purposeHash: input.payment.purposeHash?.toLowerCase() || null,
      initiatedAt: input.payment.initiatedAt.toISOString(),
    },
    travelRuleData: {
      originator_name: data.originatorName,
      originator_account: data.originatorAccount,
      originator_address: data.originatorAddress,
      beneficiary_name: data.beneficiaryName,
      beneficiary_account: data.beneficiaryAccount,
      ...(data.originatorNationalId
        ? { originator_id: data.originatorNationalId }
        : {}),
      ...(data.beneficiaryInstitution
        ? { beneficiary_institution: data.beneficiaryInstitution }
        : {}),
    },
  };
}

export function serializeCanonicalTravelRulePayload(
  payload: CanonicalTravelRulePayload,
): string {
  return JSON.stringify(payload);
}

export function travelRulePayloadCommitment(canonicalPayload: string): string {
  return keccak256(
    toUtf8Bytes(`${COMMITMENT_DOMAIN}\n${canonicalPayload}`),
  ).toLowerCase();
}

export function travelRulePartyCommitments(
  payload: CanonicalTravelRulePayload,
): { originatorHash: string; beneficiaryHash: string } {
  return {
    originatorHash: keccak256(
      toUtf8Bytes(
        `${COMMITMENT_DOMAIN}:originator:${payload.payment.paymentId}:${JSON.stringify(
          {
            name: payload.travelRuleData.originator_name,
            account: payload.travelRuleData.originator_account,
            address: payload.travelRuleData.originator_address,
            nationalId: payload.travelRuleData.originator_id || null,
          },
        )}`,
      ),
    ).toLowerCase(),
    beneficiaryHash: keccak256(
      toUtf8Bytes(
        `${COMMITMENT_DOMAIN}:beneficiary:${payload.payment.paymentId}:${JSON.stringify(
          {
            name: payload.travelRuleData.beneficiary_name,
            account: payload.travelRuleData.beneficiary_account,
            institution: payload.travelRuleData.beneficiary_institution || null,
          },
        )}`,
      ),
    ).toLowerCase(),
  };
}

function parseAesKey(raw: unknown, keyId: string): Buffer {
  if (typeof raw !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    throw new Error(
      `TRAVEL_RULE_ENCRYPTION_KEYS entry ${keyId} must be a canonical base64-encoded 32-byte key`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    throw new Error(
      `TRAVEL_RULE_ENCRYPTION_KEYS entry ${keyId} must be a canonical base64-encoded 32-byte key`,
    );
  }
  return key;
}

/** Load a bounded keyring so old records remain decryptable during rotation. */
export function loadTravelRuleEncryptionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): TravelRuleEncryptionConfiguration {
  const activeKeyId = environment.TRAVEL_RULE_ACTIVE_KEY_ID;
  if (!activeKeyId || !/^[A-Za-z0-9._-]{1,64}$/.test(activeKeyId)) {
    throw new Error(
      "TRAVEL_RULE_ACTIVE_KEY_ID must be a 1-64 character key identifier",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(environment.TRAVEL_RULE_ENCRYPTION_KEYS || "");
  } catch {
    throw new Error("TRAVEL_RULE_ENCRYPTION_KEYS must be a JSON object");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("TRAVEL_RULE_ENCRYPTION_KEYS must be a JSON object");
  }
  const entries = Object.entries(decoded as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 8) {
    throw new Error(
      "TRAVEL_RULE_ENCRYPTION_KEYS must contain between 1 and 8 keys",
    );
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, raw] of entries) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
      throw new Error(
        "TRAVEL_RULE_ENCRYPTION_KEYS contains an invalid key identifier",
      );
    }
    keys.set(keyId, parseAesKey(raw, keyId));
  }
  if (!keys.has(activeKeyId)) {
    throw new Error(
      "TRAVEL_RULE_ACTIVE_KEY_ID is not present in TRAVEL_RULE_ENCRYPTION_KEYS",
    );
  }
  return { activeKeyId, keys };
}

export function travelRuleEncryptionAad(input: {
  businessId: string;
  paymentRecordId: string;
  payloadCommitment: string;
}): Buffer {
  return Buffer.from(
    `${ENCRYPTION_DOMAIN}:${input.businessId}:${input.paymentRecordId}:${input.payloadCommitment.toLowerCase()}`,
    "utf8",
  );
}

export function encryptTravelRulePayload(input: {
  canonicalPayload: string;
  businessId: string;
  paymentRecordId: string;
  payloadCommitment: string;
  configuration?: TravelRuleEncryptionConfiguration;
}): {
  encryptedPayload: Buffer;
  encryptionIv: Buffer;
  authenticationTag: Buffer;
  encryptionKeyId: string;
} {
  const configuration =
    input.configuration || loadTravelRuleEncryptionConfiguration();
  const key = configuration.keys.get(configuration.activeKeyId);
  if (!key) throw new Error("Active Travel Rule encryption key is unavailable");
  const encryptionIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, encryptionIv);
  cipher.setAAD(travelRuleEncryptionAad(input));
  const encryptedPayload = Buffer.concat([
    cipher.update(input.canonicalPayload, "utf8"),
    cipher.final(),
  ]);
  return {
    encryptedPayload,
    encryptionIv,
    authenticationTag: cipher.getAuthTag(),
    encryptionKeyId: configuration.activeKeyId,
  };
}

export function decryptTravelRulePayload(input: {
  encryptedPayload: Buffer;
  encryptionIv: Buffer;
  authenticationTag: Buffer;
  encryptionKeyId: string;
  businessId: string;
  paymentRecordId: string;
  payloadCommitment: string;
  configuration?: TravelRuleEncryptionConfiguration;
}): string {
  const configuration =
    input.configuration || loadTravelRuleEncryptionConfiguration();
  const key = configuration.keys.get(input.encryptionKeyId);
  if (!key) throw new Error("Travel Rule record encryption key is unavailable");
  if (
    input.encryptionIv.length !== 12 ||
    input.authenticationTag.length !== 16
  ) {
    throw new Error("Travel Rule encrypted record metadata is invalid");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    input.encryptionIv,
  );
  decipher.setAAD(travelRuleEncryptionAad(input));
  decipher.setAuthTag(input.authenticationTag);
  return Buffer.concat([
    decipher.update(input.encryptedPayload),
    decipher.final(),
  ]).toString("utf8");
}

export function buildTravelRuleChallengeMessage(input: {
  address: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  challengeId: string;
  paymentId: string;
  payloadCommitment: string;
  relyingParty?: WalletRelyingParty;
}): string {
  const relyingParty = input.relyingParty || resolveWalletRelyingParty();
  return [
    `${relyingParty.domain} wants you to sign in with your Ethereum account:`,
    getAddress(input.address),
    "",
    "Authorize NoblePay to encrypt and transmit this payment's committed IVMS101 Travel Rule data to the configured compliance operator.",
    "",
    `URI: ${relyingParty.origin}`,
    "Version: 1",
    `Chain ID: ${relyingParty.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
    `Request ID: ${input.challengeId}`,
    "Resources:",
    TRAVEL_RULE_MESSAGE_PURPOSE,
    `${TRAVEL_RULE_PAYMENT_PREFIX}${input.paymentId.toLowerCase()}`,
    `${TRAVEL_RULE_COMMITMENT_PREFIX}${input.payloadCommitment.toLowerCase()}`,
  ].join("\n");
}

export function isTravelRuleChallengeBound(
  message: string,
  expected: { paymentId: string; payloadCommitment: string },
  relyingParty: WalletRelyingParty = resolveWalletRelyingParty(),
): boolean {
  const lines = message.split("\n");
  const resourceLines = lines.filter((line) => line.startsWith("- urn:"));
  return (
    lines[0] ===
      `${relyingParty.domain} wants you to sign in with your Ethereum account:` &&
    lines.includes(`URI: ${relyingParty.origin}`) &&
    lines.includes(`Chain ID: ${relyingParty.chainId}`) &&
    lines.includes("Version: 1") &&
    resourceLines.length === 3 &&
    resourceLines[0] === TRAVEL_RULE_MESSAGE_PURPOSE &&
    resourceLines[1] ===
      `${TRAVEL_RULE_PAYMENT_PREFIX}${expected.paymentId.toLowerCase()}` &&
    resourceLines[2] ===
      `${TRAVEL_RULE_COMMITMENT_PREFIX}${expected.payloadCommitment.toLowerCase()}`
  );
}

export function configuredTravelRuleThresholdUsd(
  raw = process.env.TRAVEL_RULE_THRESHOLD_USD,
): Prisma.Decimal {
  if (!raw && process.env.NODE_ENV === "test") return new Prisma.Decimal(1000);
  if (!raw || !/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(raw)) {
    throw new Error(
      "TRAVEL_RULE_THRESHOLD_USD must be a positive decimal with at most 2 fractional digits",
    );
  }
  const threshold = new Prisma.Decimal(raw);
  if (!threshold.isPositive()) {
    throw new Error("TRAVEL_RULE_THRESHOLD_USD must be greater than zero");
  }
  return threshold;
}

export function isTravelRuleRequired(input: {
  amount: { toString(): string };
  currency: string;
}): boolean {
  const currency = input.currency.trim().toUpperCase();
  if (!/^USD[A-Z0-9]{1,7}$/.test(currency)) {
    throw new Error(
      "Travel Rule threshold evaluation supports only configured USD stablecoins",
    );
  }
  return new Prisma.Decimal(input.amount.toString()).greaterThanOrEqualTo(
    configuredTravelRuleThresholdUsd(),
  );
}
