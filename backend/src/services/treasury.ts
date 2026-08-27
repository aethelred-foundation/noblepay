import {
  Prisma,
  PrismaClient,
  type SpendingPolicy as StoredPolicy,
  type TreasuryProposal as StoredProposal,
  type YieldStrategy as StoredStrategy,
} from "@prisma/client";
import { AuditService } from "./audit";
import {
  verifyTreasuryExecution,
} from "./treasury-execution";
import type { NoblePayChainConfiguration } from "../lib/production-config";

export type ProposalStatus =
  "PENDING" | "APPROVED" | "EXECUTED" | "REJECTED" | "EXPIRED";
export type ProposalType =
  "TRANSFER" | "POLICY_CHANGE" | "YIELD_ALLOCATION" | "EMERGENCY";
export type SpendingCategory =
  | "OPERATIONS"
  | "PAYROLL"
  | "MARKETING"
  | "DEVELOPMENT"
  | "COMPLIANCE"
  | "INFRASTRUCTURE"
  | "OTHER";

const SPENDING_CATEGORIES: SpendingCategory[] = [
  "OPERATIONS",
  "PAYROLL",
  "MARKETING",
  "DEVELOPMENT",
  "COMPLIANCE",
  "INFRASTRUCTURE",
  "OTHER",
];

const PROPOSAL_TYPES: ProposalType[] = [
  "TRANSFER",
  "POLICY_CHANGE",
  "YIELD_ALLOCATION",
  "EMERGENCY",
];

export interface CreateProposalInput {
  title: string;
  description: string;
  type: ProposalType;
  amount?: string;
  currency?: string;
  recipient?: string;
  category?: SpendingCategory;
  timelockHours?: number;
  metadata?: Record<string, unknown>;
}

export interface SpendingPolicy {
  id: string;
  category: string;
  dailyLimit: string;
  weeklyLimit: null;
  monthlyLimit: string;
  requiresApproval: boolean;
  minApprovals: number;
  active: boolean;
  updatedAt: Date;
  dataSource: "DATABASE_POLICY";
}

export interface YieldStrategy {
  id: string;
  protocol: string;
  name: string;
  allocation: string;
  currency: string;
  currentAPY: number;
  riskLevel: string;
  active: boolean;
  totalYieldEarned: string;
  lastHarvestAt: Date | null;
  dataSource: "DATABASE_STRATEGY";
}

export interface TreasuryProposalRecord {
  id: string;
  title: string;
  description: string;
  type: ProposalType;
  amount: string | null;
  currency: string | null;
  recipient: string | null;
  category: SpendingCategory | null;
  status: ProposalStatus;
  proposer: string;
  businessId: string;
  requiredApprovals: number;
  currentApprovals: number;
  approvers: string[];
  executeAfter: Date | null;
  createdAt: Date;
  expiresAt: Date;
  executedAt: Date | null;
  metadata: Record<string, unknown>;
  dataSource: "DATABASE_WORKFLOW";
}

export interface TreasuryOverview {
  totalAUM: string;
  allocations: Record<string, string>;
  yieldEarned: string;
  pendingProposals: number;
  activeStrategies: number;
  signerCount: number;
  monthlySpend: Record<SpendingCategory, string>;
  valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY";
  dataSource: "DATABASE_LEDGER";
  calculatedAt: Date;
}

export interface TreasuryAnalytics {
  period: "day" | "week" | "month" | "quarter";
  businessId: string;
  totalInflows: null;
  totalOutflows: string;
  netChange: null;
  avgDailySpend: string;
  topCategories: Array<{
    category: SpendingCategory;
    amount: string;
    percentage: number;
  }>;
  yieldGenerated: string;
  projectedMonthlyYield: null;
  burnRate: string;
  runwayDays: null;
  dataSource: "DATABASE_LEDGER";
}

function metadataObject(
  value: Prisma.JsonValue | null,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function proposalCategory(
  metadata: Record<string, unknown>,
): SpendingCategory | null {
  const category = metadata.category;
  return typeof category === "string" &&
    SPENDING_CATEGORIES.includes(category as SpendingCategory)
    ? (category as SpendingCategory)
    : null;
}

function proposalRecord(proposal: StoredProposal): TreasuryProposalRecord {
  const metadata = metadataObject(proposal.metadata);
  return {
    id: proposal.id,
    title: proposal.title,
    description: proposal.description,
    type: proposal.type,
    amount: proposal.amount?.toString() ?? null,
    currency: proposal.currency,
    recipient: proposal.recipient,
    category: proposalCategory(metadata),
    status: proposal.status,
    proposer: proposal.createdBy,
    businessId: proposal.businessId,
    requiredApprovals: proposal.requiredSigs,
    currentApprovals: proposal.currentSigs,
    approvers: proposal.approvedBy,
    executeAfter: proposal.timelockUntil,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    executedAt: proposal.executedAt,
    metadata,
    dataSource: "DATABASE_WORKFLOW",
  };
}

function policyRecord(policy: StoredPolicy): SpendingPolicy {
  return {
    id: policy.id,
    category: policy.category,
    dailyLimit: policy.dailyLimit.toString(),
    weeklyLimit: null,
    monthlyLimit: policy.monthlyLimit.toString(),
    requiresApproval: policy.requiresMultiSig,
    minApprovals: policy.approvalThreshold,
    active: policy.isActive,
    updatedAt: policy.updatedAt,
    dataSource: "DATABASE_POLICY",
  };
}

function strategyRecord(strategy: StoredStrategy): YieldStrategy {
  return {
    id: strategy.id,
    protocol: strategy.protocol,
    name: strategy.name,
    allocation: strategy.allocatedAmount.toString(),
    currency: strategy.currency,
    currentAPY: strategy.apy.toNumber(),
    riskLevel: strategy.riskLevel,
    active: strategy.isActive,
    totalYieldEarned: strategy.totalYieldEarned.toString(),
    lastHarvestAt: strategy.lastHarvestAt,
    dataSource: "DATABASE_STRATEGY",
  };
}

/** Treasury workflow backed exclusively by Prisma persistence. */
export class TreasuryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditService: AuditService,
  ) {}

  async getOverview(businessId: string): Promise<TreasuryOverview> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [strategies, proposals] = await Promise.all([
      this.prisma.yieldStrategy.findMany({ where: { isActive: true } }),
      this.prisma.treasuryProposal.findMany({ where: { businessId } }),
    ]);
    const allocations: Record<string, string> = {};
    let allocated = new Prisma.Decimal(0);
    let earned = new Prisma.Decimal(0);
    for (const strategy of strategies) {
      const current = new Prisma.Decimal(allocations[strategy.currency] ?? 0);
      allocations[strategy.currency] = current
        .add(strategy.allocatedAmount)
        .toString();
      allocated = allocated.add(strategy.allocatedAmount);
      earned = earned.add(strategy.totalYieldEarned);
    }
    const monthlySpend = Object.fromEntries(
      SPENDING_CATEGORIES.map((category) => [category, "0"]),
    ) as Record<SpendingCategory, string>;
    const signers = new Set<string>();
    for (const proposal of proposals) {
      proposal.approvedBy.forEach((signer) => signers.add(signer));
      if (
        proposal.status === "EXECUTED" &&
        proposal.executedAt &&
        proposal.executedAt >= startOfMonth &&
        proposal.amount
      ) {
        const category = proposalCategory(metadataObject(proposal.metadata));
        if (category) {
          monthlySpend[category] = new Prisma.Decimal(monthlySpend[category])
            .add(proposal.amount)
            .toString();
        }
      }
    }

    return {
      totalAUM: allocated.toString(),
      allocations,
      yieldEarned: earned.toString(),
      pendingProposals: proposals.filter(
        (proposal) => proposal.status === "PENDING",
      ).length,
      activeStrategies: strategies.length,
      signerCount: signers.size,
      monthlySpend,
      valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY",
      dataSource: "DATABASE_LEDGER",
      calculatedAt: now,
    };
  }

  async listProposals(
    businessId: string,
    status?: ProposalStatus,
    pagination?: { page: number; limit: number },
  ): Promise<TreasuryProposalRecord[]> {
    const proposals = await this.prisma.treasuryProposal.findMany({
      where: { businessId, status },
      orderBy: { createdAt: "desc" },
      skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
      take: pagination?.limit,
    });
    return proposals.map(proposalRecord);
  }

  async createProposal(
    input: CreateProposalInput,
    proposer: string,
    businessId: string,
  ): Promise<TreasuryProposalRecord> {
    this.validateProposal(input);
    const policy = input.category
      ? await this.prisma.spendingPolicy.findFirst({
          where: { category: input.category, isActive: true },
        })
      : null;
    if (input.amount && !policy) {
      throw new TreasuryError(
        "POLICY_NOT_FOUND",
        "An active durable spending policy is required for monetary proposals",
        409,
      );
    }
    const requiredApprovals = policy?.requiresMultiSig
      ? policy.approvalThreshold
      : 1;
    const timelockHours = input.timelockHours ?? 0;
    const now = new Date();
    const metadata: Prisma.JsonObject = {
      ...(input.metadata as Prisma.JsonObject | undefined),
      ...(input.category ? { category: input.category } : {}),
    };

    let proposal: StoredProposal;
    try {
      proposal = await this.prisma.treasuryProposal.create({
        data: {
          type: input.type,
          title: input.title.trim(),
          description: input.description.trim(),
          amount: input.amount ? new Prisma.Decimal(input.amount) : null,
          currency: input.currency?.trim().toUpperCase() || null,
          recipient: input.recipient?.trim() || null,
          status: "PENDING",
          requiredSigs: requiredApprovals,
          currentSigs: 0,
          signers: [],
          approvedBy: [],
          timelockUntil:
            timelockHours > 0
              ? new Date(now.getTime() + timelockHours * 3_600_000)
              : null,
          createdBy: proposer,
          businessId,
          expiresAt: new Date(now.getTime() + 7 * 86_400_000),
          metadata,
        },
      });
    } catch (error) {
      throw new TreasuryError(
        "PERSISTENCE_FAILURE",
        "Failed to persist the treasury proposal",
        503,
        error,
      );
    }
    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: proposer,
      description: `Treasury proposal created: ${proposal.title} (${proposal.id})`,
      severity: "MEDIUM",
      businessId,
      metadata: {
        proposalId: proposal.id,
        type: proposal.type,
        amount: proposal.amount?.toString(),
      },
    });
    return proposalRecord(proposal);
  }

  async approveProposal(
    proposalId: string,
    signer: string,
    businessId: string,
  ): Promise<{
    approved: boolean;
    remainingApprovals: number;
    status: ProposalStatus;
  }> {
    type ApprovalResult =
      { expired: true } | { expired: false; proposal: StoredProposal };
    let result: ApprovalResult;
    try {
      result = await this.prisma.$transaction(
        async (transaction) => {
          const proposal = await transaction.treasuryProposal.findFirst({
            where: { id: proposalId, businessId },
          });
          if (!proposal) {
            throw new TreasuryError(
              "PROPOSAL_NOT_FOUND",
              "Proposal not found",
              404,
            );
          }
          if (new Date() > proposal.expiresAt) {
            await transaction.treasuryProposal.update({
              where: { id: proposal.id },
              data: { status: "EXPIRED" },
            });
            return { expired: true } as const;
          }
          if (proposal.status !== "PENDING") {
            throw new TreasuryError(
              "INVALID_STATE",
              `Proposal is in ${proposal.status} state, expected PENDING`,
              409,
            );
          }
          if (proposal.approvedBy.includes(signer)) {
            throw new TreasuryError(
              "DUPLICATE_APPROVAL",
              "This signer has already approved the proposal",
              409,
            );
          }
          const approvedBy = [...proposal.approvedBy, signer];
          const approved = approvedBy.length >= proposal.requiredSigs;
          const updated = await transaction.treasuryProposal.update({
            where: { id: proposal.id },
            data: {
              approvedBy,
              currentSigs: approvedBy.length,
              status: approved ? "APPROVED" : "PENDING",
            },
          });
          return { expired: false, proposal: updated } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof TreasuryError) throw error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        throw new TreasuryError(
          "APPROVAL_CONFLICT",
          "The proposal changed concurrently; refresh and retry",
          409,
        );
      }
      throw new TreasuryError(
        "PERSISTENCE_FAILURE",
        "Failed to persist the treasury approval",
        503,
        error,
      );
    }
    if (result.expired) {
      throw new TreasuryError(
        "PROPOSAL_EXPIRED",
        "Proposal has expired and can no longer be approved",
        409,
      );
    }
    const proposal = result.proposal;
    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: signer,
      description: `Treasury proposal ${proposal.id} approved by ${signer}`,
      severity: "MEDIUM",
      businessId,
      metadata: {
        proposalId: proposal.id,
        approvals: proposal.currentSigs,
        required: proposal.requiredSigs,
      },
    });
    return {
      approved: proposal.status === "APPROVED",
      remainingApprovals: Math.max(
        0,
        proposal.requiredSigs - proposal.currentSigs,
      ),
      status: proposal.status,
    };
  }

  /**
   * Record that a proposal was executed on chain.
   *
   * This does not execute anything. The backend holds no treasury signing key:
   * execution is authorised by SIGNER_ROLE holders and submitted from their own
   * wallets. What happens here is verification of a claim — the caller supplies
   * the transaction they say settled the proposal, and the record is written
   * only if the chain corroborates it.
   *
   * The status is set from the verified receipt rather than from the request,
   * so a caller cannot mark a proposal executed by asking nicely.
   */
  async executeProposal(
    proposalId: string,
    executor: string,
    businessId: string,
    execution: { txHash: string; onChainProposalId: string },
    config: NoblePayChainConfiguration,
  ): Promise<{
    status: ProposalStatus;
    txHash: string;
    onChainProposalId: string;
    blockNumber: number;
    confirmations: number;
    executedAt: Date;
  }> {
    const proposal = await this.prisma.treasuryProposal.findFirst({
      where: { id: proposalId, businessId },
    });
    if (!proposal) {
      throw new TreasuryError("PROPOSAL_NOT_FOUND", "Proposal not found", 404);
    }
    if (proposal.status === "EXECUTED") {
      // Idempotent when the same transaction is replayed, and a conflict when a
      // different one is offered: a second, different execution of the same
      // proposal is not a retry, it is a contradiction worth surfacing.
      if (proposal.executionTxHash === execution.txHash.toLowerCase()) {
        return {
          status: proposal.status,
          txHash: proposal.executionTxHash,
          onChainProposalId: proposal.onChainProposalId ?? "",
          blockNumber: 0,
          confirmations: 0,
          executedAt: proposal.executedAt ?? new Date(),
        };
      }
      throw new TreasuryError(
        "ALREADY_EXECUTED",
        `Proposal was already executed by ${proposal.executionTxHash ?? "an unrecorded transaction"}`,
        409,
      );
    }
    if (proposal.status !== "APPROVED") {
      throw new TreasuryError(
        "INVALID_STATE",
        `Proposal is in ${proposal.status} state, expected APPROVED`,
        409,
      );
    }

    // Throws TreasuryExecutionError with a specific reason if any check fails.
    const verified = await verifyTreasuryExecution(config, execution);

    const updated = await this.prisma.treasuryProposal.update({
      where: { id: proposal.id },
      data: {
        status: "EXECUTED",
        executedAt: verified.executedAt,
        executionTxHash: verified.txHash,
        onChainProposalId: verified.onChainProposalId,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: executor,
      description: `Treasury proposal executed on chain: ${proposal.title} (${proposal.id}) via ${verified.txHash}`,
      // Higher than proposal creation: this is the entry that says funds
      // moved, and it is the one a reviewer will look for first.
      severity: "HIGH",
      businessId,
      metadata: {
        proposalId: proposal.id,
        onChainProposalId: verified.onChainProposalId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        blockHash: verified.blockHash,
        confirmations: verified.confirmations,
        // The on-chain executor, which need not be the API caller. Recording
        // both means a later reviewer can see who submitted and who reported.
        onChainExecutor: verified.executor,
        amount: verified.amount,
      },
    });

    return {
      status: updated.status,
      txHash: verified.txHash,
      onChainProposalId: verified.onChainProposalId,
      blockNumber: verified.blockNumber,
      confirmations: verified.confirmations,
      executedAt: verified.executedAt,
    };
  }

  async validateSpendingPolicy(
    amount: string,
    category: SpendingCategory,
    periodSpend: { daily: string; monthly: string },
  ): Promise<{ allowed: boolean; reason?: string }> {
    const policy = await this.prisma.spendingPolicy.findFirst({
      where: { category, isActive: true },
    });
    if (!policy) {
      return {
        allowed: false,
        reason: `No active spending policy is defined for ${category}`,
      };
    }
    const requested = new Prisma.Decimal(amount);
    if (
      new Prisma.Decimal(periodSpend.daily).add(requested).gt(policy.dailyLimit)
    ) {
      return {
        allowed: false,
        reason: `Daily spending limit exceeded for ${category}`,
      };
    }
    if (
      new Prisma.Decimal(periodSpend.monthly)
        .add(requested)
        .gt(policy.monthlyLimit)
    ) {
      return {
        allowed: false,
        reason: `Monthly spending limit exceeded for ${category}`,
      };
    }
    return { allowed: true };
  }

  async getYieldStrategies(pagination?: {
    page: number;
    limit: number;
  }): Promise<YieldStrategy[]> {
    const strategies = await this.prisma.yieldStrategy.findMany({
      orderBy: { createdAt: "desc" },
      skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
      take: pagination?.limit,
    });
    return strategies.map(strategyRecord);
  }

  async getSpendingPolicies(pagination?: {
    page: number;
    limit: number;
  }): Promise<SpendingPolicy[]> {
    const policies = await this.prisma.spendingPolicy.findMany({
      orderBy: { category: "asc" },
      skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
      take: pagination?.limit,
    });
    return policies.map(policyRecord);
  }

  async updateSpendingPolicy(
    category: SpendingCategory,
    updates: Partial<
      Pick<
        SpendingPolicy,
        | "dailyLimit"
        | "monthlyLimit"
        | "requiresApproval"
        | "minApprovals"
        | "active"
      >
    >,
  ): Promise<SpendingPolicy> {
    const policy = await this.prisma.spendingPolicy.findFirst({
      where: { category },
    });
    if (!policy) {
      throw new TreasuryError(
        "POLICY_NOT_FOUND",
        `No policy found for category: ${category}`,
        404,
      );
    }
    const updated = await this.prisma.spendingPolicy.update({
      where: { id: policy.id },
      data: {
        dailyLimit: updates.dailyLimit,
        monthlyLimit: updates.monthlyLimit,
        requiresMultiSig: updates.requiresApproval,
        approvalThreshold: updates.minApprovals,
        isActive: updates.active,
      },
    });
    return policyRecord(updated);
  }

  async getAnalytics(
    businessId: string,
    period: "day" | "week" | "month" | "quarter",
  ): Promise<TreasuryAnalytics> {
    const days = { day: 1, week: 7, month: 30, quarter: 90 }[period];
    const start = new Date(Date.now() - days * 86_400_000);
    const [proposals, strategies] = await Promise.all([
      this.prisma.treasuryProposal.findMany({
        where: {
          businessId,
          status: "EXECUTED",
          executedAt: { gte: start },
        },
      }),
      this.prisma.yieldStrategy.findMany({ where: { isActive: true } }),
    ]);
    let outflows = new Prisma.Decimal(0);
    const categories: Record<SpendingCategory, Prisma.Decimal> =
      Object.fromEntries(
        SPENDING_CATEGORIES.map((category) => [
          category,
          new Prisma.Decimal(0),
        ]),
      ) as Record<SpendingCategory, Prisma.Decimal>;
    for (const proposal of proposals) {
      if (!proposal.amount) continue;
      outflows = outflows.add(proposal.amount);
      const category = proposalCategory(metadataObject(proposal.metadata));
      if (category)
        categories[category] = categories[category].add(proposal.amount);
    }
    const yieldGenerated = strategies.reduce(
      (sum, strategy) => sum.add(strategy.totalYieldEarned),
      new Prisma.Decimal(0),
    );
    return {
      period,
      businessId,
      totalInflows: null,
      totalOutflows: outflows.toString(),
      netChange: null,
      avgDailySpend: outflows.div(days).toString(),
      topCategories: Object.entries(categories)
        .filter(([, amount]) => amount.gt(0))
        .map(([category, amount]) => ({
          category: category as SpendingCategory,
          amount: amount.toString(),
          percentage: outflows.gt(0)
            ? amount.div(outflows).mul(100).toNumber()
            : 0,
        }))
        .sort((left, right) => Number(right.amount) - Number(left.amount)),
      yieldGenerated: yieldGenerated.toString(),
      projectedMonthlyYield: null,
      burnRate: outflows.div(days).toString(),
      runwayDays: null,
      dataSource: "DATABASE_LEDGER",
    };
  }

  private validateProposal(input: CreateProposalInput): void {
    if (!input.title?.trim() || !input.description?.trim()) {
      throw new TreasuryError(
        "INVALID_PROPOSAL",
        "Proposal title and description are required",
      );
    }
    if (!PROPOSAL_TYPES.includes(input.type)) {
      throw new TreasuryError(
        "INVALID_PROPOSAL_TYPE",
        "Proposal type is invalid",
      );
    }
    if (input.category && !SPENDING_CATEGORIES.includes(input.category)) {
      throw new TreasuryError(
        "INVALID_SPENDING_CATEGORY",
        "Spending category is invalid",
      );
    }
    if (input.amount) {
      let amount: Prisma.Decimal;
      try {
        amount = new Prisma.Decimal(input.amount);
      } catch {
        throw new TreasuryError("INVALID_AMOUNT", "Proposal amount is invalid");
      }
      // Decimal.js treats positive zero as `isPositive()`. Monetary proposals
      // require a value strictly greater than zero.
      if (amount.lte(0) || !input.currency || !input.category) {
        throw new TreasuryError(
          "INVALID_MONETARY_PROPOSAL",
          "Positive amount, currency, and spending category are required",
        );
      }
    }
    if (
      input.timelockHours !== undefined &&
      (!Number.isInteger(input.timelockHours) ||
        input.timelockHours < 0 ||
        input.timelockHours > 720)
    ) {
      throw new TreasuryError(
        "INVALID_TIMELOCK",
        "Timelock must be between 0 and 720 hours",
      );
    }
  }
}

export class TreasuryError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
    options?: unknown,
  ) {
    super(message);
    if (options !== undefined) {
      (this as Error & { cause?: unknown }).cause = options;
    }
    this.name = "TreasuryError";
  }
}
