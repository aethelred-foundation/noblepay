import {
  Interface,
  JsonRpcProvider,
  Result,
  formatUnits,
  getAddress,
  id,
} from "ethers";
import { Business, BusinessTier, Prisma, PrismaClient } from "@prisma/client";
import {
  loadNoblePayChainConfiguration,
  noblePayNetworkIdentityMatches,
  parseBusinessVerifierAddress,
} from "../lib/production-config";
import { logger } from "../lib/logger";
import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import {
  CanonicalContractExecutionError,
  resolveCanonicalContractExecution,
} from "../lib/canonical-contract-execution";
import { AuditService } from "./audit";

const REGISTRY_INTERFACE = new Interface([
  "function verifyBusiness(address _business)",
  "function upgradeTier(address _business,uint8 _newTier)",
  "function suspendBusiness(address _business,string _reason)",
  "function reinstateBusiness(address _business)",
  "function revokeBusiness(address _business,string _reason)",
  "function getBusinessDetails(address _business) view returns ((address wallet,string licenseNumber,string businessName,uint8 jurisdiction,uint8 kycStatus,uint8 tier,uint256 registeredAt,uint256 lastVerified,address complianceOfficer))",
  "function getBusinessTier(address _business) view returns (uint8)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "event BusinessVerified(address indexed wallet,address indexed verifier,uint256 verifiedAt)",
  "event BusinessSuspended(address indexed wallet,string reason)",
  "event BusinessReinstated(address indexed wallet,address indexed reinstatedBy)",
  "event BusinessRevoked(address indexed wallet,string reason)",
  "event TierUpgraded(address indexed wallet,uint8 oldTier,uint8 newTier)",
]);

const NOBLEPAY_INTERFACE = new Interface([
  "function dailyVolume(address business,uint256 epoch) view returns (uint256)",
  "function monthlyVolume(address business,uint256 epoch) view returns (uint256)",
  "function getDailyLimit(uint8 tier) view returns (uint256)",
  "function getMonthlyLimit(uint8 tier) view returns (uint256)",
]);

const VERIFIER_ROLE = id("VERIFIER_ROLE");
const ADMIN_ROLE = id("ADMIN_ROLE");
const TIER_TO_CHAIN: Record<BusinessTier, number> = {
  STANDARD: 0,
  PREMIUM: 1,
  ENTERPRISE: 2,
};
const CHAIN_TO_TIER = ["STANDARD", "PREMIUM", "ENTERPRISE"] as const;
const TIER_LIMITS: Record<BusinessTier, { daily: number; monthly: number }> = {
  STANDARD: { daily: 50_000, monthly: 500_000 },
  PREMIUM: { daily: 500_000, monthly: 5_000_000 },
  ENTERPRISE: { daily: 5_000_000, monthly: 50_000_000 },
};

interface ConfirmedTransaction {
  config: ReturnType<typeof loadNoblePayChainConfiguration>;
  provider: JsonRpcProvider;
  receipt: NonNullable<
    Awaited<ReturnType<JsonRpcProvider["getTransactionReceipt"]>>
  >;
  transaction: NonNullable<
    Awaited<ReturnType<JsonRpcProvider["getTransaction"]>>
  >;
  block: NonNullable<Awaited<ReturnType<JsonRpcProvider["getBlock"]>>>;
  confirmations: number;
  txHash: string;
}

export interface BusinessReconciliationResult {
  business: Business;
  replayed: boolean;
  txHash: string;
  confirmations: number;
  chainId: string;
}

export interface BusinessLimitSnapshot {
  tier: BusinessTier;
  mirrorInSync: boolean;
  source: "onchain";
  chainId: string;
  blockNumber: string;
  daily: {
    epoch: string;
    limit: string;
    used: string;
    remaining: string;
    transactions: null;
  };
  monthly: {
    epoch: string;
    epochKind: "30-day";
    limit: string;
    used: string;
    remaining: string;
    transactions: null;
  };
}

export class BusinessReconciliationService {
  private provider: JsonRpcProvider | null = null;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
    provider?: JsonRpcProvider,
  ) {
    this.provider = provider || null;
  }

  async reconcileVerification(
    businessId: string,
    txHash: string,
  ): Promise<BusinessReconciliationResult> {
    const business = await this.findBusiness(businessId);
    const confirmed = await this.confirmRegistryTransaction(txHash);
    const { receipt, block, config, provider } = confirmed;
    const { call, actor: signer } = await this.resolveRegistryExecution(
      confirmed,
      "verifyBusiness",
      VERIFIER_ROLE,
    );
    if (
      getAddress(call.args._business as string) !== getAddress(business.address)
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_CLAIM_MISMATCH",
        "Verification transaction targets a different business wallet",
        422,
      );
    }

    this.requireConfiguredVerifier(signer);
    const events = this.registryEvents(
      receipt.logs,
      config.registryContractAddress,
      "BusinessVerified",
    );
    if (events.length !== 1) {
      throw new BusinessReconciliationError(
        "BUSINESS_VERIFICATION_EVENT_MISMATCH",
        "Receipt must contain exactly one BusinessVerified event",
        422,
      );
    }
    const event = events[0];
    const eventWallet = getAddress(event.args.wallet as string);
    const verifier = getAddress(event.args.verifier as string);
    const verifiedAt = event.args.verifiedAt as bigint;
    if (
      eventWallet !== getAddress(business.address) ||
      verifier !== signer ||
      verifiedAt !== BigInt(block.timestamp)
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_VERIFICATION_EVENT_MISMATCH",
        "BusinessVerified event does not match the business, verifier, and confirmed block",
        422,
      );
    }

    const state = await this.readBusinessState(
      provider,
      config.registryContractAddress,
      business.address,
      receipt.blockNumber,
    );
    if (
      getAddress(state.wallet as string) !== getAddress(business.address) ||
      state.licenseNumber !== business.licenseNumber ||
      state.businessName !== business.businessName ||
      Number(state.jurisdiction) !==
        this.jurisdictionValue(business.jurisdiction) ||
      Number(state.kycStatus) !== 1 ||
      Number(state.tier) !== TIER_TO_CHAIN[business.tier] ||
      BigInt(state.registeredAt) !== this.registeredAtSeconds(business) ||
      BigInt(state.lastVerified) !== verifiedAt ||
      !business.complianceOfficer ||
      getAddress(state.complianceOfficer as string) !==
        getAddress(business.complianceOfficer)
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_VERIFICATION_STATE_MISMATCH",
        "BusinessRegistry state at the confirmed block does not match the persisted registration",
        422,
      );
    }
    await this.assertStillCanonical(confirmed);

    const verifiedTime = new Date(Number(verifiedAt) * 1000);
    return this.persistTransition({
      business,
      confirmed,
      eventType: "BUSINESS_VERIFIED",
      actor: verifier,
      description: `Verified BusinessRegistry KYC transaction for ${business.businessName}`,
      expected: (current) =>
        current.kycStatus === "VERIFIED" &&
        current.lastVerified?.getTime() === verifiedTime.getTime(),
      canApply: (current) =>
        current.kycStatus === "PENDING" || current.kycStatus === "VERIFIED",
      update: { kycStatus: "VERIFIED", lastVerified: verifiedTime },
      metadata: { verifiedAt: verifiedAt.toString() },
    });
  }

  async reconcileTierUpgrade(
    businessId: string,
    newTier: "PREMIUM" | "ENTERPRISE",
    txHash: string,
  ): Promise<BusinessReconciliationResult> {
    const business = await this.findBusiness(businessId);
    const targetTier = newTier as BusinessTier;
    const targetValue = TIER_TO_CHAIN[targetTier];
    const confirmed = await this.confirmRegistryTransaction(txHash);
    const { receipt, config, provider } = confirmed;
    const { call, actor: signer } = await this.resolveRegistryExecution(
      confirmed,
      "upgradeTier",
      ADMIN_ROLE,
    );
    if (
      getAddress(call.args._business as string) !==
        getAddress(business.address) ||
      Number(call.args._newTier) !== targetValue
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_TIER_CLAIM_MISMATCH",
        "Upgrade calldata does not match the requested business and target tier",
        422,
      );
    }

    const events = this.registryEvents(
      receipt.logs,
      config.registryContractAddress,
      "TierUpgraded",
    );
    if (events.length !== 1) {
      throw new BusinessReconciliationError(
        "BUSINESS_TIER_EVENT_MISMATCH",
        "Receipt must contain exactly one TierUpgraded event",
        422,
      );
    }
    const event = events[0];
    const eventWallet = getAddress(event.args.wallet as string);
    const oldValue = Number(event.args.oldTier);
    const eventTargetValue = Number(event.args.newTier);
    if (
      eventWallet !== getAddress(business.address) ||
      !Number.isInteger(oldValue) ||
      oldValue < 0 ||
      oldValue >= targetValue ||
      eventTargetValue !== targetValue
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_TIER_EVENT_MISMATCH",
        "TierUpgraded event does not match the requested on-chain upgrade",
        422,
      );
    }

    const state = await this.readBusinessState(
      provider,
      config.registryContractAddress,
      business.address,
      receipt.blockNumber,
    );
    this.requireBusinessIdentityAndStatus(business, state, 1, targetValue);
    this.requireUnchangedLastVerified(business, state);
    await this.assertStillCanonical(confirmed);

    const limits = TIER_LIMITS[targetTier];
    return this.persistTransition({
      business,
      confirmed,
      eventType: "BUSINESS_UPGRADED",
      actor: signer,
      description: `Verified BusinessRegistry tier upgrade for ${business.businessName} to ${targetTier}`,
      expected: (current) => current.tier === targetTier,
      canApply: (current) =>
        current.kycStatus === "VERIFIED" &&
        TIER_TO_CHAIN[current.tier] === oldValue,
      update: {
        tier: targetTier,
        dailyLimit: limits.daily,
        monthlyLimit: limits.monthly,
      },
      metadata: {
        oldTier: CHAIN_TO_TIER[oldValue],
        newTier: targetTier,
        dailyLimit: limits.daily,
        monthlyLimit: limits.monthly,
      },
    });
  }

  async reconcileSuspension(
    businessId: string,
    txHash: string,
  ): Promise<BusinessReconciliationResult> {
    const business = await this.findBusiness(businessId);
    const confirmed = await this.confirmRegistryTransaction(txHash);
    const { receipt, config, provider } = confirmed;
    const { call, actor } = await this.resolveRegistryExecution(
      confirmed,
      "suspendBusiness",
      VERIFIER_ROLE,
    );
    this.requireConfiguredVerifier(actor);
    const reason = call.args._reason as string;
    if (
      getAddress(call.args._business as string) !==
        getAddress(business.address) ||
      typeof reason !== "string"
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_SUSPENSION_CLAIM_MISMATCH",
        "Suspension calldata does not match the requested business",
        422,
      );
    }
    const events = this.registryEvents(
      receipt.logs,
      config.registryContractAddress,
      "BusinessSuspended",
    );
    if (
      events.length !== 1 ||
      getAddress(events[0].args.wallet as string) !==
        getAddress(business.address) ||
      events[0].args.reason !== reason
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_SUSPENSION_EVENT_MISMATCH",
        "BusinessSuspended event does not match the confirmed call",
        422,
      );
    }
    const state = await this.readBusinessState(
      provider,
      config.registryContractAddress,
      business.address,
      receipt.blockNumber,
    );
    this.requireBusinessIdentityAndStatus(business, state, 2);
    this.requireUnchangedLastVerified(business, state);
    await this.assertStillCanonical(confirmed);
    return this.persistTransition({
      business,
      confirmed,
      eventType: "BUSINESS_SUSPENDED",
      actor,
      description: `Reconciled BusinessRegistry suspension for ${business.businessName}`,
      expected: (current) => current.kycStatus === "SUSPENDED",
      canApply: (current) => current.kycStatus === "VERIFIED",
      update: { kycStatus: "SUSPENDED" },
      metadata: { reason },
    });
  }

  async reconcileReinstatement(
    businessId: string,
    txHash: string,
  ): Promise<BusinessReconciliationResult> {
    const business = await this.findBusiness(businessId);
    const confirmed = await this.confirmRegistryTransaction(txHash);
    const { receipt, block, config, provider } = confirmed;
    const { call, actor } = await this.resolveRegistryExecution(
      confirmed,
      "reinstateBusiness",
      VERIFIER_ROLE,
    );
    this.requireConfiguredVerifier(actor);
    if (
      getAddress(call.args._business as string) !== getAddress(business.address)
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_REINSTATEMENT_CLAIM_MISMATCH",
        "Reinstatement calldata targets a different business",
        422,
      );
    }
    const events = this.registryEvents(
      receipt.logs,
      config.registryContractAddress,
      "BusinessReinstated",
    );
    if (
      events.length !== 1 ||
      getAddress(events[0].args.wallet as string) !==
        getAddress(business.address) ||
      getAddress(events[0].args.reinstatedBy as string) !== actor
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_REINSTATEMENT_EVENT_MISMATCH",
        "BusinessReinstated event does not match the confirmed verifier call",
        422,
      );
    }
    const state = await this.readBusinessState(
      provider,
      config.registryContractAddress,
      business.address,
      receipt.blockNumber,
    );
    this.requireBusinessIdentityAndStatus(business, state, 1);
    if (BigInt(state.lastVerified) !== BigInt(block.timestamp)) {
      throw new BusinessReconciliationError(
        "BUSINESS_REINSTATEMENT_STATE_MISMATCH",
        "Reinstated BusinessRegistry state has an unexpected verification time",
        422,
      );
    }
    await this.assertStillCanonical(confirmed);
    const verifiedTime = new Date(block.timestamp * 1000);
    return this.persistTransition({
      business,
      confirmed,
      eventType: "BUSINESS_REINSTATED",
      actor,
      description: `Reconciled BusinessRegistry reinstatement for ${business.businessName}`,
      expected: (current) =>
        current.kycStatus === "VERIFIED" &&
        current.lastVerified?.getTime() === verifiedTime.getTime(),
      canApply: (current) => current.kycStatus === "SUSPENDED",
      update: { kycStatus: "VERIFIED", lastVerified: verifiedTime },
      metadata: { verifiedAt: block.timestamp.toString() },
    });
  }

  async reconcileRevocation(
    businessId: string,
    txHash: string,
  ): Promise<BusinessReconciliationResult> {
    const business = await this.findBusiness(businessId);
    const confirmed = await this.confirmRegistryTransaction(txHash);
    const { receipt, config, provider } = confirmed;
    const { call, actor } = await this.resolveRegistryExecution(
      confirmed,
      "revokeBusiness",
      ADMIN_ROLE,
    );
    const reason = call.args._reason as string;
    if (
      getAddress(call.args._business as string) !==
        getAddress(business.address) ||
      typeof reason !== "string"
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_REVOCATION_CLAIM_MISMATCH",
        "Revocation calldata does not match the requested business",
        422,
      );
    }
    const events = this.registryEvents(
      receipt.logs,
      config.registryContractAddress,
      "BusinessRevoked",
    );
    if (
      events.length !== 1 ||
      getAddress(events[0].args.wallet as string) !==
        getAddress(business.address) ||
      events[0].args.reason !== reason
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_REVOCATION_EVENT_MISMATCH",
        "BusinessRevoked event does not match the confirmed admin call",
        422,
      );
    }
    const state = await this.readBusinessState(
      provider,
      config.registryContractAddress,
      business.address,
      receipt.blockNumber,
    );
    this.requireBusinessIdentityAndStatus(business, state, 3);
    this.requireUnchangedLastVerified(business, state);
    await this.assertStillCanonical(confirmed);
    return this.persistTransition({
      business,
      confirmed,
      eventType: "BUSINESS_REVOKED",
      actor,
      description: `Reconciled irreversible BusinessRegistry revocation for ${business.businessName}`,
      expected: (current) => current.kycStatus === "REVOKED",
      canApply: (current) => current.kycStatus !== "REVOKED",
      update: { kycStatus: "REVOKED" },
      metadata: { reason },
      revokeAPIKeys: true,
    });
  }

  async getOnChainLimits(businessId: string): Promise<BusinessLimitSnapshot> {
    const business = await this.findBusiness(businessId);
    let config: ReturnType<typeof loadNoblePayChainConfiguration>;
    try {
      config = loadNoblePayChainConfiguration();
    } catch {
      throw new BusinessReconciliationError(
        "BUSINESS_LIMITS_NOT_CONFIGURED",
        "On-chain business limit reads are not configured",
        503,
      );
    }
    const provider =
      this.provider || (this.provider = new JsonRpcProvider(config.rpcUrl));
    let network;
    let block;
    let anchorBlock;
    try {
      [network, block, anchorBlock] = await Promise.all([
        provider.getNetwork(),
        provider.getBlock("latest"),
        provider.getBlock(config.networkAnchorBlock),
      ]);
    } catch {
      throw new BusinessReconciliationError(
        "CHAIN_RPC_UNAVAILABLE",
        "Unable to read on-chain business limits",
        503,
      );
    }
    if (
      !block ||
      !noblePayNetworkIdentityMatches(config, network, anchorBlock)
    ) {
      throw new BusinessReconciliationError(
        "CHAIN_MISMATCH",
        "Configured RPC returned an unexpected chain or block",
        503,
      );
    }

    const dailyEpoch = BigInt(Math.floor(block.timestamp / 86_400));
    const monthlyEpoch = BigInt(Math.floor(block.timestamp / (30 * 86_400)));
    try {
      const tierRaw = await provider.call({
        to: config.registryContractAddress,
        data: REGISTRY_INTERFACE.encodeFunctionData("getBusinessTier", [
          business.address,
        ]),
        blockTag: block.number,
      });
      const [tierValueRaw] = REGISTRY_INTERFACE.decodeFunctionResult(
        "getBusinessTier",
        tierRaw,
      );
      const tierValue = Number(tierValueRaw);
      const tier = CHAIN_TO_TIER[tierValue];
      if (!tier) throw new Error("invalid tier");

      const [dailyUsedRaw, monthlyUsedRaw, dailyLimitRaw, monthlyLimitRaw] =
        await Promise.all([
          this.contractRead(
            provider,
            NOBLEPAY_INTERFACE,
            config.contractAddress,
            "dailyVolume",
            [business.address, dailyEpoch],
            block.number,
          ),
          this.contractRead(
            provider,
            NOBLEPAY_INTERFACE,
            config.contractAddress,
            "monthlyVolume",
            [business.address, monthlyEpoch],
            block.number,
          ),
          this.contractRead(
            provider,
            NOBLEPAY_INTERFACE,
            config.contractAddress,
            "getDailyLimit",
            [tierValue],
            block.number,
          ),
          this.contractRead(
            provider,
            NOBLEPAY_INTERFACE,
            config.contractAddress,
            "getMonthlyLimit",
            [tierValue],
            block.number,
          ),
        ]);
      const dailyUsed = BigInt(dailyUsedRaw[0]);
      const monthlyUsed = BigInt(monthlyUsedRaw[0]);
      const dailyLimit = BigInt(dailyLimitRaw[0]);
      const monthlyLimit = BigInt(monthlyLimitRaw[0]);

      return {
        tier,
        mirrorInSync: tier === business.tier,
        source: "onchain",
        chainId: config.chainId.toString(),
        blockNumber: block.number.toString(),
        daily: {
          epoch: dailyEpoch.toString(),
          limit: formatUnits(dailyLimit, 6),
          used: formatUnits(dailyUsed, 6),
          remaining: formatUnits(
            dailyLimit > dailyUsed ? dailyLimit - dailyUsed : 0n,
            6,
          ),
          transactions: null,
        },
        monthly: {
          epoch: monthlyEpoch.toString(),
          epochKind: "30-day",
          limit: formatUnits(monthlyLimit, 6),
          used: formatUnits(monthlyUsed, 6),
          remaining: formatUnits(
            monthlyLimit > monthlyUsed ? monthlyLimit - monthlyUsed : 0n,
            6,
          ),
          transactions: null,
        },
      };
    } catch (error) {
      if (error instanceof BusinessReconciliationError) throw error;
      logger.error("Business limit contract read failed", {
        businessId,
        error: (error as Error).message,
      });
      throw new BusinessReconciliationError(
        "BUSINESS_LIMITS_UNAVAILABLE",
        "Unable to verify the current BusinessRegistry and NoblePay limit state",
        503,
      );
    }
  }

  private async findBusiness(businessId: string): Promise<Business> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business)
      throw new BusinessReconciliationError(
        "BUSINESS_NOT_FOUND",
        "Business not found",
        404,
      );
    return business;
  }

  private async confirmRegistryTransaction(
    txHash: string,
  ): Promise<ConfirmedTransaction> {
    let config: ReturnType<typeof loadNoblePayChainConfiguration>;
    try {
      config = loadNoblePayChainConfiguration();
    } catch {
      throw new BusinessReconciliationError(
        "BUSINESS_REGISTRY_NOT_CONFIGURED",
        "BusinessRegistry reconciliation is not configured",
        503,
      );
    }
    const provider =
      this.provider || (this.provider = new JsonRpcProvider(config.rpcUrl));
    let network;
    let anchorBlock;
    try {
      [network, anchorBlock] = await Promise.all([
        provider.getNetwork(),
        provider.getBlock(config.networkAnchorBlock),
      ]);
    } catch {
      throw new BusinessReconciliationError(
        "CHAIN_RPC_UNAVAILABLE",
        "Unable to verify BusinessRegistry transaction",
        503,
      );
    }
    if (!noblePayNetworkIdentityMatches(config, network, anchorBlock)) {
      throw new BusinessReconciliationError(
        "CHAIN_MISMATCH",
        "Configured RPC returned an unexpected chain",
        503,
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
          throw new BusinessReconciliationError(
            "TRANSACTION_NOT_MINED",
            "BusinessRegistry transaction has not been mined",
            409,
          );
        case "HASH_MISMATCH":
          throw new BusinessReconciliationError(
            "TRANSACTION_HASH_MISMATCH",
            "RPC returned a different transaction",
            422,
          );
        case "REVERTED":
          throw new BusinessReconciliationError(
            "TRANSACTION_REVERTED",
            "BusinessRegistry transaction reverted",
            422,
          );
        case "INSUFFICIENT_CONFIRMATIONS":
          throw new BusinessReconciliationError(
            "INSUFFICIENT_CONFIRMATIONS",
            `BusinessRegistry transaction requires ${config.minimumConfirmations} confirmations`,
            409,
          );
        case "CANONICAL_MISMATCH":
          throw new BusinessReconciliationError(
            "TRANSACTION_CANONICAL_MISMATCH",
            "BusinessRegistry receipt is not in the canonical chain",
            422,
          );
        case "BLOCK_NOT_FOUND":
          throw new BusinessReconciliationError(
            "BLOCK_NOT_FOUND",
            "Unable to verify transaction block",
            503,
          );
        case "RPC_UNAVAILABLE":
          throw new BusinessReconciliationError(
            "CHAIN_RPC_UNAVAILABLE",
            "Unable to verify BusinessRegistry transaction",
            503,
          );
      }
    }
    const { receipt, transaction, block, confirmations } = canonical;
    if (transaction.value !== 0n) {
      throw new BusinessReconciliationError(
        "UNEXPECTED_NATIVE_VALUE",
        "BusinessRegistry transaction must not transfer value",
        422,
      );
    }
    return {
      config,
      provider,
      receipt,
      transaction,
      block,
      confirmations,
      txHash: receipt.hash.toLowerCase(),
    };
  }

  private async resolveRegistryExecution(
    confirmed: ConfirmedTransaction,
    expectedMethod: string,
    requiredRole: string,
  ) {
    const { transaction, receipt, provider, config } = confirmed;
    let execution;
    try {
      execution = await resolveCanonicalContractExecution({
        provider,
        transaction,
        blockNumber: receipt.blockNumber,
        targetContract: config.registryContractAddress,
      });
    } catch (error) {
      if (!(error instanceof CanonicalContractExecutionError)) throw error;
      throw new BusinessReconciliationError(
        "INVALID_BUSINESS_REGISTRY_EXECUTION",
        error.message,
        422,
      );
    }
    const { actor } = execution;
    const call = this.parseRegistryCall(execution.callData, 0n, expectedMethod);
    await this.requireRole(
      provider,
      config.registryContractAddress,
      requiredRole,
      actor,
      receipt.blockNumber,
    );
    return { call, actor };
  }

  private requireConfiguredVerifier(actor: string): void {
    let configuredVerifier: string;
    try {
      configuredVerifier = parseBusinessVerifierAddress();
    } catch {
      throw new BusinessReconciliationError(
        "BUSINESS_VERIFIER_NOT_CONFIGURED",
        "BUSINESS_VERIFIER_ADDRESS must identify the deployed registry verifier",
        503,
      );
    }
    if (actor !== configuredVerifier) {
      throw new BusinessReconciliationError(
        "UNEXPECTED_BUSINESS_VERIFIER",
        "Registry lifecycle transaction was not executed by BUSINESS_VERIFIER_ADDRESS",
        403,
      );
    }
  }

  private requireBusinessIdentityAndStatus(
    business: Business,
    state: Result,
    expectedStatus: number,
    expectedTier = TIER_TO_CHAIN[business.tier],
  ): void {
    if (
      getAddress(state.wallet as string) !== getAddress(business.address) ||
      state.licenseNumber !== business.licenseNumber ||
      state.businessName !== business.businessName ||
      Number(state.jurisdiction) !==
        this.jurisdictionValue(business.jurisdiction) ||
      Number(state.kycStatus) !== expectedStatus ||
      Number(state.tier) !== expectedTier ||
      BigInt(state.registeredAt) !== this.registeredAtSeconds(business) ||
      !business.complianceOfficer ||
      getAddress(state.complianceOfficer as string) !==
        getAddress(business.complianceOfficer)
    ) {
      throw new BusinessReconciliationError(
        "BUSINESS_LIFECYCLE_STATE_MISMATCH",
        "BusinessRegistry lifecycle state does not match the persisted business identity",
        422,
      );
    }
  }

  private requireUnchangedLastVerified(
    business: Business,
    state: Result,
  ): void {
    const expected = business.lastVerified
      ? BigInt(Math.floor(business.lastVerified.getTime() / 1000))
      : 0n;
    if (BigInt(state.lastVerified) !== expected) {
      throw new BusinessReconciliationError(
        "BUSINESS_LIFECYCLE_STATE_MISMATCH",
        "BusinessRegistry lifecycle state changed the verification time unexpectedly",
        422,
      );
    }
  }

  private registeredAtSeconds(business: Business): bigint {
    const timestamp = business.registeredAt.getTime();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new BusinessReconciliationError(
        "BUSINESS_REGISTRATION_CONFLICT",
        "Persisted registration time cannot be reconciled with BusinessRegistry",
        409,
      );
    }
    return BigInt(Math.floor(timestamp / 1000));
  }

  private async assertStillCanonical(
    confirmed: ConfirmedTransaction,
  ): Promise<void> {
    try {
      await assertCanonicalChainSnapshot(
        confirmed.provider,
        confirmed.config,
        confirmed.receipt.blockNumber,
        confirmed.receipt.blockHash,
        confirmed.txHash,
        confirmed.config.minimumConfirmations,
      );
    } catch (error) {
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "INSUFFICIENT_CONFIRMATIONS"
      ) {
        throw new BusinessReconciliationError(
          "INSUFFICIENT_CONFIRMATIONS",
          `BusinessRegistry transaction requires ${confirmed.config.minimumConfirmations} confirmations`,
          409,
        );
      }
      if (
        error instanceof CanonicalTransactionError &&
        error.reason === "RPC_UNAVAILABLE"
      ) {
        throw new BusinessReconciliationError(
          "CHAIN_RPC_UNAVAILABLE",
          "Unable to perform the final BusinessRegistry chain check",
          503,
        );
      }
      throw new BusinessReconciliationError(
        "TRANSACTION_CANONICAL_MISMATCH",
        "BusinessRegistry transaction block changed during reconciliation",
        422,
      );
    }
  }

  private parseRegistryCall(
    data: string,
    value: bigint,
    expectedMethod: string,
  ) {
    let call;
    try {
      call = REGISTRY_INTERFACE.parseTransaction({ data, value });
    } catch {
      call = null;
    }
    if (!call || call.name !== expectedMethod) {
      throw new BusinessReconciliationError(
        "INVALID_BUSINESS_REGISTRY_CALL",
        `Transaction calldata is not BusinessRegistry.${expectedMethod}`,
        422,
      );
    }
    return call;
  }

  private registryEvents(
    logs: readonly {
      address: string;
      topics: readonly string[];
      data: string;
    }[],
    address: string,
    name: string,
  ) {
    return logs.flatMap((log) => {
      try {
        if (getAddress(log.address) !== address) return [];
        const parsed = REGISTRY_INTERFACE.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        return parsed?.name === name ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }

  private async requireRole(
    provider: JsonRpcProvider,
    registryAddress: string,
    role: string,
    signer: string,
    blockNumber: number,
  ): Promise<void> {
    try {
      const data = REGISTRY_INTERFACE.encodeFunctionData("hasRole", [
        role,
        signer,
      ]);
      const raw = await provider.call({
        to: registryAddress,
        data,
        blockTag: blockNumber,
      });
      const [authorized] = REGISTRY_INTERFACE.decodeFunctionResult(
        "hasRole",
        raw,
      );
      if (authorized !== true) {
        throw new BusinessReconciliationError(
          "UNAUTHORIZED_CHAIN_SIGNER",
          "Transaction sender did not hold the required BusinessRegistry role at the confirmed block",
          403,
        );
      }
    } catch (error) {
      if (error instanceof BusinessReconciliationError) throw error;
      throw new BusinessReconciliationError(
        "BUSINESS_REGISTRY_STATE_UNAVAILABLE",
        "Unable to verify the transaction sender's BusinessRegistry role",
        503,
      );
    }
  }

  private async readBusinessState(
    provider: JsonRpcProvider,
    registryAddress: string,
    businessAddress: string,
    blockNumber: number,
  ) {
    try {
      const data = REGISTRY_INTERFACE.encodeFunctionData("getBusinessDetails", [
        businessAddress,
      ]);
      const raw = await provider.call({
        to: registryAddress,
        data,
        blockTag: blockNumber,
      });
      const [state] = REGISTRY_INTERFACE.decodeFunctionResult(
        "getBusinessDetails",
        raw,
      );
      return state;
    } catch {
      throw new BusinessReconciliationError(
        "BUSINESS_REGISTRY_STATE_UNAVAILABLE",
        "Unable to verify BusinessRegistry state at the confirmed block",
        503,
      );
    }
  }

  private async contractRead(
    provider: JsonRpcProvider,
    contractInterface: Interface,
    address: string,
    method: string,
    args: readonly unknown[],
    blockNumber: number,
  ) {
    const data = contractInterface.encodeFunctionData(method, args);
    const raw = await provider.call({
      to: address,
      data,
      blockTag: blockNumber,
    });
    return contractInterface.decodeFunctionResult(method, raw);
  }

  private jurisdictionValue(jurisdiction: string): number {
    if (jurisdiction.toUpperCase() === "UAE") return 0;
    if (jurisdiction.toUpperCase() === "INTERNATIONAL") return 1;
    throw new BusinessReconciliationError(
      "BUSINESS_REGISTRATION_CONFLICT",
      "Persisted jurisdiction cannot be represented by BusinessRegistry",
      409,
    );
  }

  private async persistTransition(input: {
    business: Business;
    confirmed: ConfirmedTransaction;
    eventType:
      | "BUSINESS_VERIFIED"
      | "BUSINESS_SUSPENDED"
      | "BUSINESS_REINSTATED"
      | "BUSINESS_REVOKED"
      | "BUSINESS_UPGRADED";
    actor: string;
    description: string;
    expected: (business: Business) => boolean;
    canApply: (business: Business) => boolean;
    update: Prisma.BusinessUpdateInput;
    metadata: Record<string, unknown>;
    revokeAPIKeys?: boolean;
  }): Promise<BusinessReconciliationResult> {
    const { business, confirmed } = input;
    const result = await this.withSerializableRetry(() =>
      this.prisma.$transaction(
        async (database) => {
          await database.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${business.id}))`;
          const current = await database.business.findUnique({
            where: { id: business.id },
          });
          if (!current)
            throw new BusinessReconciliationError(
              "BUSINESS_NOT_FOUND",
              "Business not found",
              404,
            );
          const priorAudit = await database.auditLog.findFirst({
            where: {
              businessId: business.id,
              txHash: confirmed.txHash,
              eventType: input.eventType,
            },
          });
          if (priorAudit) {
            if (!input.expected(current)) {
              throw new BusinessReconciliationError(
                "BUSINESS_RECONCILIATION_CONFLICT",
                "Business audit and persisted mirror state conflict",
                409,
              );
            }
            return { business: current, replayed: true };
          }
          if (!input.canApply(current)) {
            throw new BusinessReconciliationError(
              "BUSINESS_RECONCILIATION_CONFLICT",
              "Persisted business state does not match the confirmed transition's prior state",
              409,
            );
          }

          const updated = await database.business.update({
            where: { id: business.id },
            data: input.update,
          });
          if (input.revokeAPIKeys) {
            await database.aPIKey.updateMany({
              where: { businessId: business.id, status: "ACTIVE" },
              data: { status: "REVOKED", revokedAt: new Date() },
            });
          }
          await this.auditService.createAuditEntryInTransaction(database, {
            businessId: business.id,
            eventType: input.eventType,
            actor: input.actor,
            description: input.description,
            severity: "INFO",
            blockNumber: BigInt(confirmed.receipt.blockNumber),
            txHash: confirmed.txHash,
            metadata: {
              ...input.metadata,
              businessId: business.id,
              chainId: confirmed.config.chainId.toString(),
              confirmations: confirmed.confirmations,
            },
          });
          return { business: updated, replayed: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
    return {
      ...result,
      txHash: confirmed.txHash,
      confirmations: confirmed.confirmations,
      chainId: confirmed.config.chainId.toString(),
    };
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

export class BusinessReconciliationError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "BusinessReconciliationError";
  }
}
