import { Interface, JsonRpcProvider, getAddress } from "ethers";
import { Business, Prisma, PrismaClient } from "@prisma/client";
import { CreateBusinessInput } from "../middleware/validation";
import { generateAPIKey } from "../middleware/auth";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";
import {
  buildRegistrationCommitment,
  isRegistrationChallengeBound,
  isWalletChallengeBound,
} from "../lib/wallet-challenge";
import {
  noblePayNetworkIdentityMatches,
  parseNetworkAnchorBlock,
  parseNetworkAnchorHash,
  parseNonZeroAddress,
} from "../lib/production-config";
import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import { isCurrentWalletMessageSignatureValid } from "../lib/wallet-signature-authorization";
import {
  CanonicalContractExecutionError,
  resolveCanonicalContractExecution,
} from "../lib/canonical-contract-execution";

const REGISTRY_INTERFACE = new Interface([
  "function registerBusiness(string _licenseNumber,string _businessName,uint8 _jurisdiction,address _complianceOfficer)",
  "function getBusinessDetails(address _business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "event BusinessRegistered(address indexed wallet,string licenseNumber,string businessName,uint8 jurisdiction)",
]);

interface RegistryConfiguration {
  rpcUrl: string;
  chainId: bigint;
  networkAnchorBlock: bigint;
  networkAnchorHash: string;
  contractAddress: string;
  minimumConfirmations: number;
}

export interface BusinessRegistrationResult {
  business: Business;
  apiKey: string;
  replayed: boolean;
  confirmations: number;
  chainId: string;
}

export class BusinessRegistrationService {
  private provider: JsonRpcProvider | null = null;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
    provider?: JsonRpcProvider,
  ) {
    this.provider = provider || null;
  }

  async register(
    input: CreateBusinessInput,
  ): Promise<BusinessRegistrationResult> {
    const address = getAddress(input.address);
    const txHash = input.txHash.toLowerCase();
    const registrationCommitment = buildRegistrationCommitment({
      address,
      txHash,
      licenseNumber: input.licenseNumber,
      businessName: input.businessName,
      jurisdiction: input.jurisdiction,
      businessType: input.businessType,
      complianceOfficer: input.complianceOfficer,
      contactEmail: input.contactEmail,
    });
    const challenge = await this.prisma.walletChallenge.findUnique({
      where: { id: input.challengeId },
    });
    let relyingPartyBound = false;
    try {
      relyingPartyBound = Boolean(
        challenge && isWalletChallengeBound(challenge.message),
      );
    } catch {
      throw new BusinessRegistrationError(
        "REGISTRATION_MISCONFIGURED",
        "Registration challenge relying-party configuration is invalid",
        503,
      );
    }
    if (
      !challenge ||
      challenge.purpose !== "REGISTRATION" ||
      challenge.usedAt ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.address.toLowerCase() !== address.toLowerCase() ||
      challenge.transactionHash?.toLowerCase() !== txHash ||
      !relyingPartyBound ||
      !isRegistrationChallengeBound(challenge.message, {
        txHash,
        registrationCommitment,
      })
    ) {
      throw new BusinessRegistrationError(
        "INVALID_REGISTRATION_CHALLENGE",
        "Registration challenge is invalid, expired, or already used",
        401,
      );
    }

    const config = this.loadConfiguration();
    const provider =
      this.provider || (this.provider = new JsonRpcProvider(config.rpcUrl));
    let network;
    let anchorBlock;
    try {
      [network, anchorBlock] = await Promise.all([
        provider.getNetwork(),
        provider.getBlock(config.networkAnchorBlock),
      ]);
    } catch (error) {
      logger.error("Business registration RPC request failed", {
        error: (error as Error).message,
      });
      throw new BusinessRegistrationError(
        "CHAIN_RPC_UNAVAILABLE",
        "Unable to verify registration with the configured chain RPC",
        503,
      );
    }

    if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
      throw new BusinessRegistrationError(
        "CHAIN_MISMATCH",
        "Configured RPC returned an unexpected chain",
        503,
      );
    }

    let validSignature: boolean;
    try {
      validSignature = await isCurrentWalletMessageSignatureValid(
        address,
        challenge.message,
        input.signature,
        provider,
        config,
      );
    } catch (error) {
      logger.error("Wallet signature chain verification failed", {
        error: (error as Error).message,
      });
      throw new BusinessRegistrationError(
        "SIGNATURE_VERIFICATION_UNAVAILABLE",
        "Unable to verify the registration wallet signature on the configured chain",
        503,
      );
    }
    if (!validSignature) {
      throw new BusinessRegistrationError(
        "INVALID_SIGNATURE",
        "Wallet signature does not match the registering address",
        401,
      );
    }

    let canonical;
    try {
      canonical = await getCanonicalTransaction(
        provider,
        txHash,
        config.minimumConfirmations,
      );
    } catch (error) {
      if (!(error instanceof CanonicalTransactionError)) throw error;
      switch (error.reason) {
        case "NOT_MINED":
          throw new BusinessRegistrationError(
            "TRANSACTION_NOT_MINED",
            "Registration transaction is unknown or has not been mined",
            409,
          );
        case "HASH_MISMATCH":
          throw new BusinessRegistrationError(
            "TRANSACTION_HASH_MISMATCH",
            "RPC returned a different registration transaction",
            422,
          );
        case "REVERTED":
          throw new BusinessRegistrationError(
            "TRANSACTION_REVERTED",
            "Registration transaction reverted",
            422,
          );
        case "INSUFFICIENT_CONFIRMATIONS":
          throw new BusinessRegistrationError(
            "INSUFFICIENT_CONFIRMATIONS",
            `Registration requires ${config.minimumConfirmations} confirmations`,
            409,
          );
        case "CANONICAL_MISMATCH":
          throw new BusinessRegistrationError(
            "TRANSACTION_CANONICAL_MISMATCH",
            "Registration receipt is not in the canonical chain",
            422,
          );
        case "BLOCK_NOT_FOUND":
          throw new BusinessRegistrationError(
            "BLOCK_NOT_FOUND",
            "Unable to verify registration block",
            503,
          );
        case "RPC_UNAVAILABLE":
          throw new BusinessRegistrationError(
            "CHAIN_RPC_UNAVAILABLE",
            "Unable to verify registration with the configured chain RPC",
            503,
          );
      }
    }
    const { receipt, transaction, block, confirmations } = canonical;
    if (transaction.value !== 0n) {
      throw new BusinessRegistrationError(
        "UNEXPECTED_NATIVE_VALUE",
        "Business registration must not transfer native value",
        422,
      );
    }
    if (!transaction.to) {
      throw new BusinessRegistrationError(
        "WRONG_REGISTRY_CONTRACT",
        "Registration transaction must target the registry or the registering Safe",
        422,
      );
    }
    const topLevelTarget = getAddress(transaction.to);
    if (
      topLevelTarget !== config.contractAddress &&
      topLevelTarget !== address
    ) {
      throw new BusinessRegistrationError(
        "WRONG_REGISTRY_CONTRACT",
        "Registration transaction targets an unrelated contract",
        422,
      );
    }
    if (
      topLevelTarget === config.contractAddress &&
      getAddress(transaction.from) !== address
    ) {
      throw new BusinessRegistrationError(
        "REGISTRATION_SENDER_MISMATCH",
        "Direct registration sender does not match the signed wallet",
        403,
      );
    }

    let execution;
    try {
      execution = await resolveCanonicalContractExecution({
        provider,
        transaction,
        blockNumber: receipt.blockNumber,
        targetContract: config.contractAddress,
        expectedActor: address,
      });
    } catch (error) {
      if (!(error instanceof CanonicalContractExecutionError)) throw error;
      throw new BusinessRegistrationError(
        "INVALID_REGISTRATION_EXECUTION",
        error.message,
        422,
      );
    }

    let call;
    try {
      call = REGISTRY_INTERFACE.parseTransaction({
        data: execution.callData,
        value: 0n,
      });
    } catch {
      call = null;
    }
    if (!call || call.name !== "registerBusiness") {
      throw new BusinessRegistrationError(
        "INVALID_REGISTRATION_CALL",
        "Transaction calldata is not BusinessRegistry.registerBusiness",
        422,
      );
    }

    const jurisdiction = this.normalizeJurisdiction(input.jurisdiction);
    const jurisdictionValue = jurisdiction === "UAE" ? 0n : 1n;
    if (
      (call.args._licenseNumber as string) !== input.licenseNumber ||
      (call.args._businessName as string) !== input.businessName ||
      (call.args._jurisdiction as bigint) !== jurisdictionValue ||
      getAddress(call.args._complianceOfficer as string) !==
        getAddress(input.complianceOfficer)
    ) {
      throw new BusinessRegistrationError(
        "REGISTRATION_CLAIM_MISMATCH",
        "Submitted business fields do not match the verified registration calldata",
        422,
      );
    }

    const events = receipt.logs.flatMap((log) => {
      if (getAddress(log.address) !== config.contractAddress) return [];
      try {
        const parsed = REGISTRY_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (!parsed || parsed.name !== "BusinessRegistered") return [];
        return [
          {
            wallet: getAddress(parsed.args.wallet as string),
            licenseNumber: parsed.args.licenseNumber as string,
            businessName: parsed.args.businessName as string,
            jurisdiction: parsed.args.jurisdiction as bigint,
          },
        ];
      } catch {
        return [];
      }
    });
    if (events.length !== 1) {
      throw new BusinessRegistrationError(
        "REGISTRATION_EVENT_INVALID",
        "Receipt must contain exactly one BusinessRegistered event",
        422,
      );
    }
    const event = events[0];
    if (
      event.wallet !== address ||
      event.licenseNumber !== input.licenseNumber ||
      event.businessName !== input.businessName ||
      event.jurisdiction !== jurisdictionValue
    ) {
      throw new BusinessRegistrationError(
        "REGISTRATION_EVENT_MISMATCH",
        "BusinessRegistered event does not match the signed request",
        422,
      );
    }

    try {
      const stateCall = REGISTRY_INTERFACE.encodeFunctionData(
        "getBusinessDetails",
        [address],
      );
      const rawState = await provider.call({
        to: config.contractAddress,
        data: stateCall,
        blockTag: receipt.blockNumber,
      });
      const [state] = REGISTRY_INTERFACE.decodeFunctionResult(
        "getBusinessDetails",
        rawState,
      );
      if (
        getAddress(state.wallet as string) !== address ||
        state.licenseNumber !== input.licenseNumber ||
        state.businessName !== input.businessName ||
        Number(state.jurisdiction) !== Number(jurisdictionValue) ||
        Number(state.kycStatus) !== 0 ||
        Number(state.tier) !== 0 ||
        BigInt(state.registeredAt) !== BigInt(block.timestamp) ||
        BigInt(state.lastVerified) !== 0n ||
        getAddress(state.complianceOfficer as string) !==
          getAddress(input.complianceOfficer)
      ) {
        throw new BusinessRegistrationError(
          "REGISTRATION_STATE_MISMATCH",
          "BusinessRegistry state at the confirmed block does not match the signed registration",
          422,
        );
      }
    } catch (error) {
      if (error instanceof BusinessRegistrationError) throw error;
      throw new BusinessRegistrationError(
        "REGISTRATION_STATE_UNAVAILABLE",
        "Unable to verify BusinessRegistry state at the confirmed block",
        503,
      );
    }

    try {
      await assertCanonicalChainSnapshot(
        provider,
        config,
        receipt.blockNumber,
        receipt.blockHash,
        receipt.hash,
        config.minimumConfirmations,
      );
    } catch (error) {
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "INSUFFICIENT_CONFIRMATIONS"
      ) {
        throw new BusinessRegistrationError(
          "INSUFFICIENT_CONFIRMATIONS",
          `Registration requires ${config.minimumConfirmations} confirmations`,
          409,
        );
      }
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "RPC_UNAVAILABLE"
      ) {
        throw new BusinessRegistrationError(
          "CHAIN_RPC_UNAVAILABLE",
          "Unable to perform the final registration chain check",
          503,
        );
      }
      throw new BusinessRegistrationError(
        "TRANSACTION_CANONICAL_MISMATCH",
        "Registration block changed while its wallet and registry state were verified",
        422,
      );
    }

    const { rawKey, keyHash } = generateAPIKey();
    const result = await this.withSerializableRetry(() =>
      this.prisma.$transaction(
        async (database) => {
          await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${address.toLowerCase()}))`;
          const consumed = await database.walletChallenge.updateMany({
            where: {
              id: challenge.id,
              purpose: "REGISTRATION",
              transactionHash: txHash,
              usedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { usedAt: new Date() },
          });
          if (consumed.count !== 1) {
            throw new BusinessRegistrationError(
              "REGISTRATION_CHALLENGE_ALREADY_USED",
              "Registration challenge has already been consumed",
              409,
            );
          }

          const existing = await database.business.findFirst({
            where: {
              OR: [
                { address: { equals: address, mode: "insensitive" } },
                { licenseNumber: input.licenseNumber },
                { registrationTxHash: txHash },
              ],
            },
          });
          let business: Business;
          let replayed = false;
          if (existing) {
            const exactMatch =
              existing.address.toLowerCase() === address.toLowerCase() &&
              existing.licenseNumber === input.licenseNumber &&
              existing.businessName === input.businessName &&
              existing.jurisdiction === jurisdiction &&
              existing.businessType === input.businessType &&
              existing.complianceOfficer?.toLowerCase() ===
                input.complianceOfficer.toLowerCase() &&
              existing.contactEmail.toLowerCase() ===
                input.contactEmail.toLowerCase() &&
              existing.registrationTxHash?.toLowerCase() === txHash;
            if (!exactMatch) {
              throw new BusinessRegistrationError(
                "REGISTRATION_CONFLICT",
                "Registration is already associated with different profile data",
                409,
              );
            }
            business = existing;
            replayed = true;
            // A signed retry rotates only the registration-issued key. This lets
            // a wallet recover if the original one-time response was lost.
            await database.aPIKey.updateMany({
              where: {
                businessId: business.id,
                name: "Default API Key",
                status: "ACTIVE",
              },
              data: { status: "REVOKED", revokedAt: new Date() },
            });
          } else {
            business = await database.business.create({
              data: {
                address,
                licenseNumber: input.licenseNumber,
                businessName: input.businessName,
                jurisdiction,
                businessType: input.businessType,
                complianceOfficer: getAddress(input.complianceOfficer),
                contactEmail: input.contactEmail,
                kycStatus: "PENDING",
                tier: "STANDARD",
                dailyLimit: 50_000,
                monthlyLimit: 500_000,
                registeredAt: new Date(block.timestamp * 1000),
                registrationTxHash: txHash,
                registrationBlockNumber: BigInt(receipt.blockNumber),
              },
            });
            await this.auditService.createAuditEntryInTransaction(database, {
              businessId: business.id,
              eventType: "BUSINESS_REGISTERED",
              actor: address,
              description: `Business "${input.businessName}" registered on-chain in ${jurisdiction}`,
              severity: "INFO",
              blockNumber: BigInt(receipt.blockNumber),
              txHash,
              metadata: {
                businessId: business.id,
                jurisdiction,
                businessType: input.businessType,
                chainId: config.chainId.toString(),
              },
            });
          }

          await database.aPIKey.create({
            data: {
              businessId: business.id,
              keyHash,
              name: "Default API Key",
              status: "ACTIVE",
            },
          });
          await this.auditService.createAuditEntryInTransaction(database, {
            businessId: business.id,
            eventType: "API_KEY_CREATED",
            actor: address,
            description: replayed
              ? "Registration API key rotated after signed finalization retry"
              : "Initial registration API key created",
            severity: "INFO",
            metadata: {
              reason: replayed ? "registration-retry" : "registration",
            },
          });
          return { business, replayed };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    logger.info("Business registration finalized", {
      businessId: result.business.id,
      chainId: config.chainId.toString(),
      replayed: result.replayed,
    });
    return {
      ...result,
      apiKey: rawKey,
      confirmations,
      chainId: config.chainId.toString(),
    };
  }

  private normalizeJurisdiction(value: string): "UAE" | "INTERNATIONAL" {
    const normalized = value.trim().toUpperCase();
    if (normalized === "UAE") return "UAE";
    if (normalized === "INTERNATIONAL") return "INTERNATIONAL";
    throw new BusinessRegistrationError(
      "INVALID_JURISDICTION",
      "Jurisdiction must be UAE or International",
      422,
    );
  }

  private loadConfiguration(): RegistryConfiguration {
    const rpcUrl = process.env.AETHELRED_RPC_URL;
    const contract = process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS;
    const chainIdValue = process.env.NOBLEPAY_CHAIN_ID;
    if (!rpcUrl || !contract || !chainIdValue) {
      throw new BusinessRegistrationError(
        "REGISTRATION_NOT_CONFIGURED",
        "On-chain business registration verification is not configured",
        503,
      );
    }

    try {
      const parsedUrl = new URL(rpcUrl);
      if (!["http:", "https:"].includes(parsedUrl.protocol))
        throw new Error("Invalid RPC protocol");
      const chainId = BigInt(chainIdValue);
      if (chainId <= 0n) throw new Error("Invalid chain ID");
      const contractAddress = parseNonZeroAddress(
        contract,
        "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
      );
      const networkAnchorBlock = parseNetworkAnchorBlock(
        process.env.AETHELRED_NETWORK_ANCHOR_BLOCK,
      );
      const networkAnchorHash = parseNetworkAnchorHash(
        process.env.AETHELRED_NETWORK_ANCHOR_HASH,
      );
      const minimumConfirmations = Number(
        process.env.NOBLEPAY_MIN_CONFIRMATIONS || "1",
      );
      if (
        !Number.isSafeInteger(minimumConfirmations) ||
        minimumConfirmations < 1
      ) {
        throw new Error("Invalid confirmations");
      }
      return {
        rpcUrl,
        chainId,
        networkAnchorBlock,
        networkAnchorHash,
        contractAddress,
        minimumConfirmations,
      };
    } catch {
      throw new BusinessRegistrationError(
        "REGISTRATION_MISCONFIGURED",
        "On-chain registration configuration is invalid",
        503,
      );
    }
  }

  private async withSerializableRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";
        if (!retryable || attempt === 2) throw error;
      }
    }
    throw new Error("Unreachable serializable retry state");
  }
}

export class BusinessRegistrationError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "BusinessRegistrationError";
  }
}
