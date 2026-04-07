import { PrismaClient, Prisma } from "@prisma/client";
import { generateHexId, generateOpaqueId } from "../lib/identifiers";
import { logger, maskIdentifier, maskTransactionHash } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProposalStatus = "PENDING" | "APPROVED" | "EXECUTED" | "REJECTED" | "CANCELLED" | "EXPIRED";
export type ProposalType = "TRANSFER" | "BUDGET_ALLOCATION" | "YIELD_STRATEGY" | "SIGNER_ROTATION" | "POLICY_CHANGE" | "EMERGENCY";
export type SpendingCategory = "OPERATIONS" | "PAYROLL" | "MARKETING" | "DEVELOPMENT" | "COMPLIANCE" | "INFRASTRUCTURE" | "OTHER";

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
  category: SpendingCategory;
  dailyLimit: string;
  weeklyLimit: string;
  monthlyLimit: string;
  requiresApproval: boolean;
  minApprovals: number;
}

export interface YieldStrategy {
  id: string;
  protocol: string;
  allocation: string;
  currency: string;
  currentAPY: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  active: boolean;
}

export interface TreasuryOverview {
  totalAUM: string;
  allocations: Record<string, string>;
  yieldEarned: string;
  pendingProposals: number;
  activeStrategies: number;
  signerCount: number;
  monthlySpend: Record<SpendingCategory, string>;
}

export interface ApprovalThreshold {
  minAmount: string;
  maxAmount: string;
  requiredApprovals: number;
  timelockHours: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const APPROVAL_THRESHOLDS: ApprovalThreshold[] = [
  { minAmount: "0", maxAmount: "10000", requiredApprovals: 2, timelockHours: 0 },
  { minAmount: "10000", maxAmount: "100000", requiredApprovals: 3, timelockHours: 6 },
  { minAmount: "100000", maxAmount: "1000000", requiredApprovals: 4, timelockHours: 24 },
  { minAmount: "1000000", maxAmount: "999999999", requiredApprovals: 5, timelockHours: 48 },
];

const DEFAULT_SPENDING_POLICIES: SpendingPolicy[] = [
  { category: "OPERATIONS", dailyLimit: "50000", weeklyLimit: "200000", monthlyLimit: "500000", requiresApproval: false, minApprovals: 0 },
  { category: "PAYROLL", dailyLimit: "500000", weeklyLimit: "500000", monthlyLimit: "2000000", requiresApproval: true, minApprovals: 2 },
  { category: "MARKETING", dailyLimit: "10000", weeklyLimit: "50000", monthlyLimit: "150000", requiresApproval: true, minApprovals: 2 },
  { category: "DEVELOPMENT", dailyLimit: "25000", weeklyLimit: "100000", monthlyLimit: "300000", requiresApproval: true, minApprovals: 2 },
  { category: "COMPLIANCE", dailyLimit: "100000", weeklyLimit: "300000", monthlyLimit: "1000000", requiresApproval: true, minApprovals: 3 },
  { category: "INFRASTRUCTURE", dailyLimit: "20000", weeklyLimit: "80000", monthlyLimit: "250000", requiresApproval: true, minApprovals: 2 },
  { category: "OTHER", dailyLimit: "5000", weeklyLimit: "20000", monthlyLimit: "50000", requiresApproval: true, minApprovals: 3 },
];

// ─── Service ────────────────────────────────────────────────────────────────

interface StoredProposal {
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
  rejectors: string[];
  timelockHours: number;
  executeAfter: Date | null;
  createdAt: Date;
  expiresAt: Date;
  metadata: Record<string, unknown>;
}

export class TreasuryService {
  private spendingPolicies: SpendingPolicy[] = DEFAULT_SPENDING_POLICIES;
  private yieldStrategies: YieldStrategy[] = [];
  private proposals: Map<string, StoredProposal> = new Map();
  private persistenceEnabled: boolean = false;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {
    this.initializeYieldStrategies();
  }

  private initializeYieldStrategies(): void {
    this.yieldStrategies = [
      { id: "ys-001", protocol: "Aethelred Staking", allocation: "5000000", currency: "AET", currentAPY: 8.5, riskLevel: "LOW", active: true },
      { id: "ys-002", protocol: "USDC Lending Pool", allocation: "2000000", currency: "USDC", currentAPY: 4.2, riskLevel: "LOW", active: true },
      { id: "ys-003", protocol: "AED Stability Module", allocation: "1000000", currency: "AED", currentAPY: 3.8, riskLevel: "LOW", active: true },
      { id: "ys-004", protocol: "Liquidity Mining", allocation: "500000", currency: "AET", currentAPY: 12.1, riskLevel: "MEDIUM", active: false },
    ];
  }

  /**
   * Get a comprehensive overview of the treasury state.
   */
  async getOverview(businessId: string): Promise<TreasuryOverview> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const allocations: Record<string, string> = {
      AET: "15000000",
      USDC: "8500000",
      USDT: "3200000",
      AED: "12000000",
    };

    const totalAUM = Object.values(allocations).reduce(
      (sum, val) => sum + parseFloat(val),
      0,
    );

    const activeStrategies = this.yieldStrategies.filter((s) => s.active).length;

    const yieldEarned = this.yieldStrategies
      .filter((s) => s.active)
      .reduce((sum, s) => {
        const monthlyYield = (parseFloat(s.allocation) * s.currentAPY) / 100 / 12;
        return sum + monthlyYield;
      }, 0);

    const monthlySpend: Record<SpendingCategory, string> = {
      OPERATIONS: "125000",
      PAYROLL: "450000",
      MARKETING: "35000",
      DEVELOPMENT: "180000",
      COMPLIANCE: "95000",
      INFRASTRUCTURE: "42000",
      OTHER: "12000",
    };

    logger.info("Treasury overview generated", {
      businessRef: maskIdentifier(businessId),
      totalAUM: totalAUM.toString(),
    });

    return {
      totalAUM: totalAUM.toFixed(2),
      allocations,
      yieldEarned: yieldEarned.toFixed(2),
      pendingProposals: 0,
      activeStrategies,
      signerCount: 5,
      monthlySpend,
    };
  }

  /**
   * Create a new treasury proposal requiring multi-sig approval.
   */
  async createProposal(
    input: CreateProposalInput,
    proposer: string,
    businessId: string,
  ): Promise<Record<string, unknown>> {
    const threshold = this.getApprovalThreshold(input.amount || "0");

    const proposalId = generateOpaqueId("prop");

    const timelockHours = input.timelockHours ?? threshold.timelockHours;
    const executeAfter = timelockHours > 0
      ? new Date(Date.now() + timelockHours * 60 * 60 * 1000)
      : null;

    const proposal: StoredProposal = {
      id: proposalId,
      title: input.title,
      description: input.description,
      type: input.type,
      amount: input.amount || null,
      currency: input.currency || null,
      recipient: input.recipient || null,
      category: input.category || null,
      status: "PENDING" as ProposalStatus,
      proposer,
      businessId,
      requiredApprovals: threshold.requiredApprovals,
      currentApprovals: 0,
      approvers: [] as string[],
      rejectors: [] as string[],
      timelockHours,
      executeAfter,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      metadata: input.metadata || {},
    };

    // Store proposal for state tracking (in-memory + Prisma for durability)
    this.proposals.set(proposalId, proposal);

    try {
      await this.prisma.treasuryProposal.create({
        data: {
          id: proposalId,
          type: input.type as any,
          title: input.title,
          description: input.description,
          amount: input.amount ? parseFloat(input.amount) : null,
          currency: input.currency || null,
          recipient: input.recipient || null,
          status: "PENDING" as any,
          requiredSigs: threshold.requiredApprovals,
          currentSigs: 0,
          signers: [],
          approvedBy: [],
          timelockUntil: executeAfter,
          createdBy: proposer,
          businessId,
          expiresAt: proposal.expiresAt,
          metadata: (input.metadata || {}) as any,
        },
      });
      this.persistenceEnabled = true;
    } catch (err) {
      if (process.env.NODE_ENV === "test") {
        // In test mode, allow in-memory fallback
        logger.warn("Failed to persist proposal to database (test mode), using in-memory only");
      } else {
        // In production, treasury proposals MUST be durable — fail closed
        this.proposals.delete(proposalId);
        throw new TreasuryError(
          "PERSISTENCE_FAILURE",
          "Failed to persist treasury proposal — refusing to operate without durable state",
          503,
        );
      }
    }

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: proposer,
      description: `Treasury proposal created: ${input.title} (${proposalId})`,
      severity: "MEDIUM",
      metadata: { proposalId, type: input.type, amount: input.amount },
    });

    logger.info("Treasury proposal created", {
      proposalId,
      type: input.type,
      amount: input.amount,
      requiredApprovals: threshold.requiredApprovals,
    });

    return proposal as unknown as Record<string, unknown>;
  }

  /**
   * Approve a treasury proposal. Returns updated proposal state.
   */
  async approveProposal(
    proposalId: string,
    signer: string,
    callerBusinessId?: string,
  ): Promise<{ approved: boolean; remainingApprovals: number; status: ProposalStatus }> {
    // Try to load from in-memory first, then fall back to Prisma
    let proposal = this.proposals.get(proposalId);

    if (!proposal) {
      // Attempt to restore from Prisma
      try {
        const dbProposal = await this.prisma.treasuryProposal.findUnique({
          where: { id: proposalId },
        });
        if (dbProposal) {
          proposal = {
            id: dbProposal.id,
            title: dbProposal.title,
            description: dbProposal.description,
            type: dbProposal.type as ProposalType,
            amount: dbProposal.amount?.toString() || null,
            currency: dbProposal.currency,
            recipient: dbProposal.recipient,
            category: null,
            status: dbProposal.status as ProposalStatus,
            proposer: dbProposal.createdBy,
            businessId: (dbProposal as any).businessId || dbProposal.createdBy,
            requiredApprovals: dbProposal.requiredSigs,
            currentApprovals: dbProposal.currentSigs,
            approvers: dbProposal.approvedBy,
            rejectors: [],
            timelockHours: 0,
            executeAfter: dbProposal.timelockUntil,
            createdAt: dbProposal.createdAt,
            expiresAt: dbProposal.expiresAt,
            metadata: (dbProposal.metadata as Record<string, unknown>) || {},
          };
          this.proposals.set(proposalId, proposal);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "test") {
          logger.error("Failed to restore proposal from database", { error: (err as Error).message });
          throw new TreasuryError(
            "PERSISTENCE_FAILURE",
            "Database unavailable — cannot verify proposal state",
            503,
          );
        }
      }
    }

    if (!proposal) {
      throw new TreasuryError(
        "PROPOSAL_NOT_FOUND",
        "Proposal not found",
        404,
      );
    }

    // Verify caller belongs to the same business as the proposal creator
    if (callerBusinessId && proposal.businessId && callerBusinessId !== proposal.businessId) {
      throw new TreasuryError(
        "FORBIDDEN",
        "You do not have permission to approve this proposal",
        403,
      );
    }

    // Verify proposal has not expired
    if (new Date() > proposal.expiresAt) {
      proposal.status = "EXPIRED" as ProposalStatus;
      throw new TreasuryError(
        "PROPOSAL_EXPIRED",
        "Proposal has expired and can no longer be approved",
        409,
      );
    }

    // Verify proposal is in PENDING state
    if (proposal.status !== "PENDING") {
      throw new TreasuryError(
        "INVALID_STATE",
        `Proposal is in ${proposal.status} state, expected PENDING`,
        409,
      );
    }

    // Check caller hasn't already approved (by signer identity, not business)
    if (proposal.approvers.includes(signer)) {
      throw new TreasuryError(
        "DUPLICATE_APPROVAL",
        `Signer ${signer} has already approved this proposal`,
        409,
      );
    }

    // Compute new state without mutating yet
    const newApprovers = [...proposal.approvers, signer];
    const newApprovalCount = newApprovers.length;
    const approved = newApprovalCount >= proposal.requiredApprovals;
    const newStatus = approved ? "APPROVED" : proposal.status;

    // Persist to database FIRST — fail closed before mutating in-memory state
    try {
      await this.prisma.treasuryProposal.update({
        where: { id: proposalId },
        data: {
          currentSigs: newApprovalCount,
          approvedBy: newApprovers,
          status: newStatus,
        },
      });
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        logger.error("Failed to persist treasury approval to database", { error: (err as Error).message });
        throw new TreasuryError(
          "PERSISTENCE_FAILURE",
          "Failed to persist treasury approval — refusing to operate without durable state",
          503,
        );
      }
    }

    // Only mutate in-memory state AFTER successful persistence
    proposal.approvers = newApprovers;
    proposal.currentApprovals = newApprovalCount;
    proposal.status = newStatus;

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: signer,
      description: `Treasury proposal ${proposalId} approved by ${signer} (${proposal.currentApprovals}/${proposal.requiredApprovals})`,
      severity: "MEDIUM",
      metadata: { proposalId, approvals: proposal.currentApprovals, required: proposal.requiredApprovals },
    });

    logger.info("Proposal approval recorded", {
      proposalRef: maskIdentifier(proposalId),
      signerRef: maskIdentifier(signer),
      approvals: proposal.currentApprovals,
      required: proposal.requiredApprovals,
      approved,
    });

    return {
      approved,
      remainingApprovals: Math.max(0, proposal.requiredApprovals - proposal.currentApprovals),
      status: proposal.status,
    };
  }

  /**
   * Execute an approved proposal after timelock expires.
   */
  async executeProposal(
    proposalId: string,
    executor: string,
    callerBusinessId?: string,
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    // Try to load from in-memory first, then fall back to Prisma
    let proposal = this.proposals.get(proposalId);

    if (!proposal) {
      try {
        const dbProposal = await this.prisma.treasuryProposal.findUnique({
          where: { id: proposalId },
        });
        if (dbProposal) {
          proposal = {
            id: dbProposal.id,
            title: dbProposal.title,
            description: dbProposal.description,
            type: dbProposal.type as ProposalType,
            amount: dbProposal.amount?.toString() || null,
            currency: dbProposal.currency,
            recipient: dbProposal.recipient,
            category: null,
            status: dbProposal.status as ProposalStatus,
            proposer: dbProposal.createdBy,
            businessId: (dbProposal as any).businessId || dbProposal.createdBy,
            requiredApprovals: dbProposal.requiredSigs,
            currentApprovals: dbProposal.currentSigs,
            approvers: dbProposal.approvedBy,
            rejectors: [],
            timelockHours: 0,
            executeAfter: dbProposal.timelockUntil,
            createdAt: dbProposal.createdAt,
            expiresAt: dbProposal.expiresAt,
            metadata: (dbProposal.metadata as Record<string, unknown>) || {},
          };
          this.proposals.set(proposalId, proposal);
        }
      } catch (err) {
        if (process.env.NODE_ENV !== "test") {
          logger.error("Failed to restore proposal from database", { error: (err as Error).message });
          throw new TreasuryError(
            "PERSISTENCE_FAILURE",
            "Database unavailable — cannot verify proposal state",
            503,
          );
        }
      }
    }

    if (!proposal) {
      throw new TreasuryError(
        "PROPOSAL_NOT_FOUND",
        "Proposal not found",
        404,
      );
    }

    // Verify caller belongs to the same business as the proposal creator
    if (callerBusinessId && proposal.businessId && callerBusinessId !== proposal.businessId) {
      throw new TreasuryError(
        "FORBIDDEN",
        "You do not have permission to execute this proposal",
        403,
      );
    }

    // Verify proposal has not expired
    if (new Date() > proposal.expiresAt) {
      proposal.status = "EXPIRED" as ProposalStatus;
      throw new TreasuryError(
        "PROPOSAL_EXPIRED",
        "Proposal has expired and can no longer be executed",
        409,
      );
    }

    // Verify proposal status is APPROVED
    if (proposal.status !== "APPROVED") {
      throw new TreasuryError(
        "INVALID_STATE",
        `Proposal is in ${proposal.status} state, expected APPROVED`,
        409,
      );
    }

    // Verify proposal has enough approvals
    if (proposal.currentApprovals < proposal.requiredApprovals) {
      throw new TreasuryError(
        "INSUFFICIENT_APPROVALS",
        `Proposal requires ${proposal.requiredApprovals} approvals but has ${proposal.currentApprovals}`,
        409,
      );
    }

    // Verify timelock has passed
    if (proposal.executeAfter && new Date() < proposal.executeAfter) {
      throw new TreasuryError(
        "TIMELOCK_ACTIVE",
        `Proposal timelock has not expired. Executable after ${proposal.executeAfter.toISOString()}`,
        409,
      );
    }

    const txHash = generateHexId();

    // Persist to database FIRST — fail closed before mutating in-memory state
    try {
      await this.prisma.treasuryProposal.update({
        where: { id: proposalId },
        data: {
          status: "EXECUTED",
          executedAt: new Date(),
        },
      });
    } catch (err) {
      if (process.env.NODE_ENV !== "test") {
        logger.error("Failed to persist treasury execution to database", { error: (err as Error).message });
        throw new TreasuryError(
          "PERSISTENCE_FAILURE",
          "Failed to persist treasury execution — refusing to operate without durable state",
          503,
        );
      }
    }

    // Only mutate in-memory state AFTER successful persistence
    proposal.status = "EXECUTED";

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: executor,
      description: `Treasury proposal ${proposalId} executed`,
      severity: "HIGH",
      metadata: { proposalId, txHash },
    });

    logger.info("Proposal executed", {
      proposalRef: maskIdentifier(proposalId),
      executorRef: maskIdentifier(executor),
      txHashRef: maskTransactionHash(txHash),
    });

    return { success: true, txHash };
  }

  /**
   * Validate a spending request against the configured policies.
   */
  validateSpendingPolicy(
    amount: string,
    category: SpendingCategory,
    periodSpend: { daily: string; weekly: string; monthly: string },
  ): { allowed: boolean; reason?: string } {
    const policy = this.spendingPolicies.find((p) => p.category === category);
    if (!policy) {
      return { allowed: false, reason: `No spending policy defined for category: ${category}` };
    }

    const amountNum = parseFloat(amount);

    if (parseFloat(periodSpend.daily) + amountNum > parseFloat(policy.dailyLimit)) {
      return { allowed: false, reason: `Daily spending limit exceeded for ${category}` };
    }

    if (parseFloat(periodSpend.weekly) + amountNum > parseFloat(policy.weeklyLimit)) {
      return { allowed: false, reason: `Weekly spending limit exceeded for ${category}` };
    }

    if (parseFloat(periodSpend.monthly) + amountNum > parseFloat(policy.monthlyLimit)) {
      return { allowed: false, reason: `Monthly spending limit exceeded for ${category}` };
    }

    return { allowed: true };
  }

  /**
   * Get the approval threshold for a given amount.
   */
  private getApprovalThreshold(amount: string): ApprovalThreshold {
    const amountNum = parseFloat(amount) || 0;
    return (
      APPROVAL_THRESHOLDS.find(
        (t) => amountNum >= parseFloat(t.minAmount) && amountNum < parseFloat(t.maxAmount),
      ) || APPROVAL_THRESHOLDS[APPROVAL_THRESHOLDS.length - 1]
    );
  }

  /**
   * Get active yield strategies.
   */
  getYieldStrategies(): YieldStrategy[] {
    return this.yieldStrategies;
  }

  /**
   * Get current spending policies.
   */
  getSpendingPolicies(): SpendingPolicy[] {
    return this.spendingPolicies;
  }

  /**
   * Update a spending policy for a category.
   */
  updateSpendingPolicy(category: SpendingCategory, updates: Partial<SpendingPolicy>): SpendingPolicy {
    const index = this.spendingPolicies.findIndex((p) => p.category === category);
    if (index === -1) {
      throw new TreasuryError("POLICY_NOT_FOUND", `No policy found for category: ${category}`, 404);
    }

    this.spendingPolicies[index] = { ...this.spendingPolicies[index], ...updates, category };
    logger.info("Spending policy updated", { category, updates });
    return this.spendingPolicies[index];
  }

  /**
   * Calculate treasury analytics for reporting.
   */
  async getAnalytics(businessId: string, period: "day" | "week" | "month" | "quarter"): Promise<Record<string, unknown>> {
    const periodMultiplier = { day: 1, week: 7, month: 30, quarter: 90 };
    const days = periodMultiplier[period];

    return {
      period,
      businessId,
      totalInflows: "2450000",
      totalOutflows: "1890000",
      netChange: "560000",
      avgDailySpend: (1890000 / days).toFixed(2),
      topCategories: [
        { category: "PAYROLL", amount: "450000", percentage: 23.8 },
        { category: "OPERATIONS", amount: "325000", percentage: 17.2 },
        { category: "DEVELOPMENT", amount: "280000", percentage: 14.8 },
      ],
      yieldGenerated: "45200",
      projectedMonthlyYield: "52000",
      burnRate: (1890000 / days).toFixed(2),
      runwayDays: Math.floor(38700000 / (1890000 / days)),
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class TreasuryError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "TreasuryError";
  }
}
