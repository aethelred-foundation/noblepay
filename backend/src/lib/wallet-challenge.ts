import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";

export interface WalletRelyingParty {
  origin: string;
  domain: string;
  chainId: string;
}

export interface RegistrationCommitmentInput {
  address: string;
  txHash: string;
  licenseNumber: string;
  businessName: string;
  jurisdiction: string;
  businessType: string;
  complianceOfficer: string;
  contactEmail: string;
}

const REGISTRATION_COMMITMENT_DOMAIN = keccak256(
  toUtf8Bytes(
    "NoblePayBusinessRegistration(address address,bytes32 txHash,string licenseNumber,string businessName,uint8 jurisdiction,string businessType,address complianceOfficer,string contactEmail)",
  ),
);
const REGISTRATION_COMMITMENT_PREFIX =
  "- urn:noblepay:registration-commitment:";
const TRANSACTION_PREFIX = "- urn:noblepay:transaction:";
const PURPOSE_PREFIX = "- urn:noblepay:purpose:";

/**
 * Commit the complete registration claim with canonical EVM ABI encoding.
 * Dynamic strings are encoded as distinct ABI values (never packed), so field
 * boundaries cannot be rearranged to produce the same signed commitment.
 */
export function buildRegistrationCommitment(
  input: RegistrationCommitmentInput,
): string {
  const txHash = input.txHash.toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(txHash))
    throw new Error("Registration transaction hash must be bytes32");

  const jurisdiction = input.jurisdiction.trim().toUpperCase();
  if (jurisdiction !== "UAE" && jurisdiction !== "INTERNATIONAL") {
    throw new Error("Registration jurisdiction is invalid");
  }
  const licenseNumber = input.licenseNumber.trim();
  const businessName = input.businessName.trim();
  const businessType = input.businessType.trim();
  const contactEmail = input.contactEmail.trim().toLowerCase();
  if (!licenseNumber || !businessName || !businessType || !contactEmail) {
    throw new Error("Registration commitment fields must not be empty");
  }

  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      [
        "bytes32",
        "address",
        "bytes32",
        "string",
        "string",
        "uint8",
        "string",
        "address",
        "string",
      ],
      [
        REGISTRATION_COMMITMENT_DOMAIN,
        getAddress(input.address),
        txHash,
        licenseNumber,
        businessName,
        jurisdiction === "UAE" ? 0 : 1,
        businessType,
        getAddress(input.complianceOfficer),
        contactEmail,
      ],
    ),
  );
}

export function resolveWalletRelyingParty(
  environment: NodeJS.ProcessEnv = process.env,
): WalletRelyingParty {
  const configuredOrigin =
    environment.PUBLIC_ORIGIN ||
    environment.CORS_ORIGIN?.split(",")[0]?.trim() ||
    "http://localhost:3008";
  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== configuredOrigin ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only an HTTP(S) origin");
  }
  const chainId = environment.NOBLEPAY_CHAIN_ID || "7332";
  if (!/^\d+$/.test(chainId) || BigInt(chainId) <= 0n) {
    throw new Error("NOBLEPAY_CHAIN_ID must be a positive integer");
  }
  return { origin: parsed.origin, domain: parsed.host, chainId };
}

export function buildWalletChallengeMessage(input: {
  address: string;
  purpose: "authentication" | "registration";
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  challengeId: string;
  txHash?: string;
  registrationCommitment?: string;
  relyingParty?: WalletRelyingParty;
}): string {
  const relyingParty = input.relyingParty || resolveWalletRelyingParty();
  const statement =
    input.purpose === "registration"
      ? "Authorize NoblePay to finalize the referenced on-chain business registration."
      : "Authenticate this browser session with NoblePay.";
  const lines = [
    `${relyingParty.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    statement,
    "",
    `URI: ${relyingParty.origin}`,
    "Version: 1",
    `Chain ID: ${relyingParty.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expiration Time: ${input.expiresAt.toISOString()}`,
    `Request ID: ${input.challengeId}`,
    "Resources:",
    `- urn:noblepay:purpose:${input.purpose}`,
  ];
  if (input.txHash)
    lines.push(`${TRANSACTION_PREFIX}${input.txHash.toLowerCase()}`);
  if (input.purpose === "registration") {
    if (
      !input.registrationCommitment ||
      !/^0x[a-fA-F0-9]{64}$/.test(input.registrationCommitment)
    ) {
      throw new Error(
        "Registration challenge requires a bytes32 profile commitment",
      );
    }
    lines.push(
      `${REGISTRATION_COMMITMENT_PREFIX}${input.registrationCommitment.toLowerCase()}`,
    );
  }
  return lines.join("\n");
}

/** Require one exact purpose, transaction, and full-profile commitment resource. */
export function isRegistrationChallengeBound(
  message: string,
  expected: { txHash: string; registrationCommitment: string },
): boolean {
  const lines = message.split("\n");
  const purposeResources = lines.filter((line) =>
    line.startsWith(PURPOSE_PREFIX),
  );
  const transactionResources = lines.filter((line) =>
    line.startsWith(TRANSACTION_PREFIX),
  );
  const commitmentResources = lines.filter((line) =>
    line.startsWith(REGISTRATION_COMMITMENT_PREFIX),
  );
  return (
    purposeResources.length === 1 &&
    purposeResources[0] === `${PURPOSE_PREFIX}registration` &&
    transactionResources.length === 1 &&
    transactionResources[0] ===
      `${TRANSACTION_PREFIX}${expected.txHash.toLowerCase()}` &&
    commitmentResources.length === 1 &&
    commitmentResources[0] ===
      `${REGISTRATION_COMMITMENT_PREFIX}${expected.registrationCommitment.toLowerCase()}`
  );
}

export function isWalletChallengeBound(
  message: string,
  relyingParty: WalletRelyingParty = resolveWalletRelyingParty(),
): boolean {
  const lines = message.split("\n");
  return (
    lines[0] ===
      `${relyingParty.domain} wants you to sign in with your Ethereum account:` &&
    lines.includes(`URI: ${relyingParty.origin}`) &&
    lines.includes(`Chain ID: ${relyingParty.chainId}`) &&
    lines.includes("Version: 1")
  );
}
