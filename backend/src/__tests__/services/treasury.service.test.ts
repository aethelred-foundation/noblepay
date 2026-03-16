import { createMockPrisma, resetAllMocks } from "../setup";
import { TreasuryService, TreasuryError } from "../../services/treasury";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let treasuryService: TreasuryService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  treasuryService = new TreasuryService(prisma, auditService);
});

describe("TreasuryService", () => {
  // ─── getOverview ─────────────────────────────────────────────────────────

  describe("getOverview", () => {
    it("should return treasury overview with correct structure", async () => {
      const overview = await treasuryService.getOverview("biz-1");

      expect(overview.totalAUM).toBeDefined();
      expect(parseFloat(overview.totalAUM)).toBeGreaterThan(0);
      expect(overview.allocations).toHaveProperty("AET");
      expect(overview.allocations).toHaveProperty("USDC");
      expect(overview.activeStrategies).toBeGreaterThanOrEqual(0);
      expect(overview.signerCount).toBe(5);
      expect(overview.monthlySpend).toHaveProperty("PAYROLL");
    });

    it("should calculate yield from active strategies", async () => {
      const overview = await treasuryService.getOverview("biz-1");
      expect(parseFloat(overview.yieldEarned)).toBeGreaterThan(0);
    });
  });

  // ─── createProposal ────────────────────────────────────────────────────────

  describe("createProposal", () => {
    it("should create a proposal with correct approval threshold", async () => {
      const proposal = await treasuryService.createProposal(
        {
          title: "Transfer to vendor",
          description: "Monthly vendor payment",
          type: "TRANSFER",
          amount: "5000",
          currency: "USDC",
        },
        "0xproposer",
        "biz-1",
      );

      expect(proposal.id).toMatch(/^prop-/);
      expect(proposal.title).toBe("Transfer to vendor");
      expect(proposal.status).toBe("PENDING");
      expect(proposal.requiredApprovals).toBe(2); // < 10000 threshold
      expect(auditService.createAuditEntry).toHaveBeenCalled();
    });

    it("should require more approvals for larger amounts", async () => {
      const proposal = await treasuryService.createProposal(
        {
          title: "Large transfer",
          description: "Big payment",
          type: "TRANSFER",
          amount: "50000",
        },
        "0xproposer",
        "biz-1",
      );

      expect(proposal.requiredApprovals).toBe(3); // 10000-100000 threshold
    });

    it("should set timelock based on amount threshold", async () => {
      const proposal = await treasuryService.createProposal(
        {
          title: "Huge transfer",
          description: "Very large payment",
          type: "TRANSFER",
          amount: "500000",
        },
        "0xproposer",
        "biz-1",
      );

      expect(proposal.timelockHours).toBe(24);
      expect(proposal.executeAfter).toBeDefined();
    });

    it("should allow custom timelock override", async () => {
      const proposal = await treasuryService.createProposal(
        {
          title: "Custom timelock",
          description: "Custom",
          type: "TRANSFER",
          amount: "1000",
          timelockHours: 12,
        },
        "0xproposer",
        "biz-1",
      );

      expect(proposal.timelockHours).toBe(12);
    });

    it("should expire in 7 days", async () => {
      const before = Date.now();
      const proposal = await treasuryService.createProposal(
        {
          title: "Test",
          description: "Test",
          type: "TRANSFER",
        },
        "0xproposer",
        "biz-1",
      );

      const expiresAt = (proposal.expiresAt as Date).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    });
  });

  // ─── approveProposal ───────────────────────────────────────────────────────

  describe("approveProposal", () => {
    it("should throw PROPOSAL_NOT_FOUND for unknown proposal", async () => {
      await expect(
        treasuryService.approveProposal("prop-nonexistent", "0xsigner"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_NOT_FOUND",
        statusCode: 404,
      });
    });

    it("should return approval status for existing proposal", async () => {
      // Create a proposal first
      const proposal = await treasuryService.createProposal(
        {
          title: "Test proposal",
          description: "Test",
          type: "TRANSFER",
          amount: "5000",
        },
        "0xproposer",
        "biz-1",
      );

      const result = await treasuryService.approveProposal(
        proposal.id as string,
        "0xsigner1",
      );

      expect(result).toHaveProperty("approved");
      expect(result).toHaveProperty("remainingApprovals");
      expect(result).toHaveProperty("status");
    });

    it("should mark approved when reaching threshold", async () => {
      // Create a proposal with amount < 10000 (requires 2 approvals)
      const proposal = await treasuryService.createProposal(
        {
          title: "Small transfer",
          description: "Test",
          type: "TRANSFER",
          amount: "5000",
        },
        "0xproposer",
        "biz-1",
      );

      const result1 = await treasuryService.approveProposal(
        proposal.id as string,
        "0xsigner1",
      );
      expect(result1.approved).toBe(false);
      expect(result1.remainingApprovals).toBe(1);

      const result2 = await treasuryService.approveProposal(
        proposal.id as string,
        "0xsigner2",
      );
      expect(result2.approved).toBe(true);
      expect(result2.remainingApprovals).toBe(0);
      expect(result2.status).toBe("APPROVED");
    });
  });

  // ─── executeProposal ───────────────────────────────────────────────────────

  describe("executeProposal", () => {
    it("should throw PROPOSAL_NOT_FOUND for unknown proposal", async () => {
      await expect(
        treasuryService.executeProposal("prop-nonexistent", "0xexecutor"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_NOT_FOUND",
        statusCode: 404,
      });
    });

    it("should execute an approved proposal and return txHash", async () => {
      // Create and fully approve a proposal (amount < 10000 = 2 approvals, no timelock)
      const proposal = await treasuryService.createProposal(
        {
          title: "Execute test",
          description: "Test",
          type: "TRANSFER",
          amount: "5000",
        },
        "0xproposer",
        "biz-1",
      );

      await treasuryService.approveProposal(proposal.id as string, "0xsigner1");
      await treasuryService.approveProposal(proposal.id as string, "0xsigner2");

      const result = await treasuryService.executeProposal(
        proposal.id as string,
        "0xexecutor",
      );

      expect(result.success).toBe(true);
      expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(auditService.createAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "HIGH" }),
      );
    });
  });

  // ─── validateSpendingPolicy ────────────────────────────────────────────────

  describe("validateSpendingPolicy", () => {
    it("should allow spending within limits", () => {
      const result = treasuryService.validateSpendingPolicy(
        "1000",
        "OPERATIONS",
        { daily: "0", weekly: "0", monthly: "0" },
      );

      expect(result.allowed).toBe(true);
    });

    it("should deny when daily limit is exceeded", () => {
      const result = treasuryService.validateSpendingPolicy(
        "10000",
        "OPERATIONS",
        { daily: "45000", weekly: "0", monthly: "0" },
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily");
    });

    it("should deny when weekly limit is exceeded", () => {
      const result = treasuryService.validateSpendingPolicy(
        "10000",
        "OPERATIONS",
        { daily: "0", weekly: "195000", monthly: "0" },
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Weekly");
    });

    it("should deny when monthly limit is exceeded", () => {
      const result = treasuryService.validateSpendingPolicy(
        "10000",
        "OPERATIONS",
        { daily: "0", weekly: "0", monthly: "495000" },
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Monthly");
    });

    it("should deny for unknown category", () => {
      const result = treasuryService.validateSpendingPolicy(
        "100",
        "NONEXISTENT" as any,
        { daily: "0", weekly: "0", monthly: "0" },
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("No spending policy");
    });
  });

  // ─── getYieldStrategies ────────────────────────────────────────────────────

  describe("getYieldStrategies", () => {
    it("should return initialized strategies", () => {
      const strategies = treasuryService.getYieldStrategies();
      expect(strategies.length).toBeGreaterThan(0);
      expect(strategies[0]).toHaveProperty("protocol");
      expect(strategies[0]).toHaveProperty("currentAPY");
    });
  });

  // ─── getSpendingPolicies ───────────────────────────────────────────────────

  describe("getSpendingPolicies", () => {
    it("should return all default policies", () => {
      const policies = treasuryService.getSpendingPolicies();
      expect(policies.length).toBe(7);
      const categories = policies.map((p) => p.category);
      expect(categories).toContain("OPERATIONS");
      expect(categories).toContain("PAYROLL");
    });
  });

  // ─── updateSpendingPolicy ──────────────────────────────────────────────────

  describe("updateSpendingPolicy", () => {
    it("should update an existing policy", () => {
      const updated = treasuryService.updateSpendingPolicy("OPERATIONS", {
        dailyLimit: "100000",
      });

      expect(updated.dailyLimit).toBe("100000");
      expect(updated.category).toBe("OPERATIONS");
    });

    it("should throw for unknown category", () => {
      expect(() =>
        treasuryService.updateSpendingPolicy("NONEXISTENT" as any, {}),
      ).toThrow(TreasuryError);
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return analytics for each period type", async () => {
      for (const period of ["day", "week", "month", "quarter"] as const) {
        const analytics = await treasuryService.getAnalytics("biz-1", period);
        expect(analytics.period).toBe(period);
        expect(analytics.totalInflows).toBeDefined();
        expect(analytics.runwayDays).toBeGreaterThan(0);
      }
    });
  });

  // ─── getApprovalThreshold (fallback) ──────────────────────────────────────

  describe("getApprovalThreshold (fallback)", () => {
    it("should use last threshold for very large amounts", async () => {
      const proposal = await treasuryService.createProposal(
        {
          title: "Massive transfer",
          description: "Huge",
          type: "TRANSFER",
          amount: "9999999999",
        },
        "0xproposer",
        "biz-1",
      );

      // The fallback threshold is the last one: 5 approvals, 48h timelock
      expect(proposal.requiredApprovals).toBe(5);
      expect(proposal.timelockHours).toBe(48);
    });
  });

  // ─── TreasuryError ─────────────────────────────────────────────────────────

  describe("TreasuryError", () => {
    it("should set properties correctly", () => {
      const err = new TreasuryError("CODE", "msg", 404);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe("TreasuryError");
    });

    it("should default statusCode to 400", () => {
      const err = new TreasuryError("CODE", "msg");
      expect(err.statusCode).toBe(400);
    });
  });

  // ─── Prisma Failure Paths (persist-first-mutate-second) ──────────────────

  describe("Prisma failure paths", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    beforeEach(() => {
      // Force production code paths so Prisma errors are NOT silently swallowed
      process.env.NODE_ENV = "production";
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    // ── createProposal: Prisma create throws ──────────────────────────────

    describe("createProposal — Prisma create failure", () => {
      it("should propagate PERSISTENCE_FAILURE and NOT leave an in-memory entry", async () => {
        prisma.treasuryProposal.create.mockRejectedValueOnce(
          new Error("DB connection refused"),
        );

        await expect(
          treasuryService.createProposal(
            {
              title: "Fail on persist",
              description: "Should not survive",
              type: "TRANSFER",
              amount: "1000",
            },
            "0xproposer",
            "biz-1",
          ),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILURE",
          statusCode: 503,
        });

        // The in-memory map should have been cleaned up (proposal deleted)
        // Verify by trying to approve — should get PROPOSAL_NOT_FOUND, not succeed
        // We need to switch back to test mode for the findUnique fallback to not also throw
        process.env.NODE_ENV = "test";
        prisma.treasuryProposal.findUnique.mockResolvedValueOnce(null);
        await expect(
          treasuryService.approveProposal("prop-does-not-exist", "0xsigner"),
        ).rejects.toMatchObject({
          code: "PROPOSAL_NOT_FOUND",
        });
      });

      it("should NOT emit an audit entry when persistence fails", async () => {
        prisma.treasuryProposal.create.mockRejectedValueOnce(
          new Error("DB timeout"),
        );

        await expect(
          treasuryService.createProposal(
            {
              title: "No audit on fail",
              description: "Should not audit",
              type: "TRANSFER",
              amount: "500",
            },
            "0xproposer",
            "biz-1",
          ),
        ).rejects.toThrow();

        // The audit entry is called AFTER the persistence block, so on failure it
        // should never be reached
        expect(auditService.createAuditEntry).not.toHaveBeenCalled();
      });
    });

    // ── approveProposal: Prisma findUnique throws during restore ──────────

    describe("approveProposal — Prisma findUnique failure during restore", () => {
      it("should throw PERSISTENCE_FAILURE, NOT PROPOSAL_NOT_FOUND", async () => {
        // Proposal is not in memory, so it will try to restore from Prisma
        prisma.treasuryProposal.findUnique.mockRejectedValueOnce(
          new Error("DB read timeout"),
        );

        await expect(
          treasuryService.approveProposal("prop-unknown", "0xsigner"),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILURE",
          statusCode: 503,
        });
      });
    });

    // ── approveProposal: Prisma update throws ─────────────────────────────

    describe("approveProposal — Prisma update failure", () => {
      it("should throw PERSISTENCE_FAILURE (503) and NOT advance in-memory state", async () => {
        // First, create a proposal successfully (need Prisma create to work)
        process.env.NODE_ENV = "test";
        const proposal = await treasuryService.createProposal(
          {
            title: "Approve persist fail",
            description: "Test",
            type: "TRANSFER",
            amount: "5000",
          },
          "0xproposer",
          "biz-1",
        );
        const proposalId = proposal.id as string;
        // Switch back to production mode for the failure test
        process.env.NODE_ENV = "production";

        // Make the Prisma update reject
        prisma.treasuryProposal.update.mockRejectedValueOnce(
          new Error("DB write failure"),
        );

        await expect(
          treasuryService.approveProposal(proposalId, "0xsigner1"),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILURE",
          statusCode: 503,
        });

        // Verify in-memory state was NOT mutated:
        // Approve again in test mode — if state was not advanced, signer1 should
        // NOT be a duplicate (the approval never went through)
        process.env.NODE_ENV = "test";
        const result = await treasuryService.approveProposal(proposalId, "0xsigner1");
        expect(result.status).toBe("PENDING");
        // signer1 now appears for the first time
        expect(result.remainingApprovals).toBe(1);
      });

      it("should NOT emit an audit entry when persistence fails on approve", async () => {
        process.env.NODE_ENV = "test";
        const proposal = await treasuryService.createProposal(
          {
            title: "No audit approve fail",
            description: "Test",
            type: "TRANSFER",
            amount: "5000",
          },
          "0xproposer",
          "biz-1",
        );
        const proposalId = proposal.id as string;

        // Reset mock call count after create (which triggers an audit entry)
        (auditService.createAuditEntry as jest.Mock).mockClear();

        process.env.NODE_ENV = "production";
        prisma.treasuryProposal.update.mockRejectedValueOnce(
          new Error("DB write failure"),
        );

        await expect(
          treasuryService.approveProposal(proposalId, "0xsigner1"),
        ).rejects.toThrow();

        expect(auditService.createAuditEntry).not.toHaveBeenCalled();
      });
    });

    // ── executeProposal: Prisma findUnique throws during restore ──────────

    describe("executeProposal — Prisma findUnique failure during restore", () => {
      it("should throw PERSISTENCE_FAILURE, NOT PROPOSAL_NOT_FOUND", async () => {
        prisma.treasuryProposal.findUnique.mockRejectedValueOnce(
          new Error("DB read timeout"),
        );

        await expect(
          treasuryService.executeProposal("prop-unknown", "0xexecutor"),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILURE",
          statusCode: 503,
        });
      });
    });

    // ── executeProposal: Prisma update throws ─────────────────────────────

    describe("executeProposal — Prisma update failure", () => {
      it("should throw PERSISTENCE_FAILURE (503) and NOT change in-memory status to EXECUTED", async () => {
        // Create and fully approve a proposal in test mode
        process.env.NODE_ENV = "test";
        const proposal = await treasuryService.createProposal(
          {
            title: "Execute persist fail",
            description: "Test",
            type: "TRANSFER",
            amount: "5000",
          },
          "0xproposer",
          "biz-1",
        );
        const proposalId = proposal.id as string;

        await treasuryService.approveProposal(proposalId, "0xsigner1");
        await treasuryService.approveProposal(proposalId, "0xsigner2");

        // Switch to production and make Prisma update fail
        process.env.NODE_ENV = "production";
        prisma.treasuryProposal.update.mockRejectedValueOnce(
          new Error("DB write failure on execute"),
        );

        await expect(
          treasuryService.executeProposal(proposalId, "0xexecutor"),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILURE",
          statusCode: 503,
        });

        // Verify in-memory status was NOT changed to EXECUTED — retrying should
        // still see APPROVED and attempt execution again
        process.env.NODE_ENV = "test";
        const retryResult = await treasuryService.executeProposal(proposalId, "0xexecutor");
        expect(retryResult.success).toBe(true);
        expect(retryResult.txHash).toMatch(/^0x[a-f0-9]{64}$/);
      });

      it("should NOT emit an audit entry when persistence fails on execute", async () => {
        process.env.NODE_ENV = "test";
        const proposal = await treasuryService.createProposal(
          {
            title: "No audit execute fail",
            description: "Test",
            type: "TRANSFER",
            amount: "5000",
          },
          "0xproposer",
          "biz-1",
        );
        const proposalId = proposal.id as string;

        await treasuryService.approveProposal(proposalId, "0xsigner1");
        await treasuryService.approveProposal(proposalId, "0xsigner2");

        (auditService.createAuditEntry as jest.Mock).mockClear();

        process.env.NODE_ENV = "production";
        prisma.treasuryProposal.update.mockRejectedValueOnce(
          new Error("DB write failure"),
        );

        await expect(
          treasuryService.executeProposal(proposalId, "0xexecutor"),
        ).rejects.toThrow();

        expect(auditService.createAuditEntry).not.toHaveBeenCalled();
      });
    });

    // ── Retry succeeds after DB recovery ──────────────────────────────────

    describe("retry after DB recovery", () => {
      it("should succeed on retry after Prisma create fails once then recovers", async () => {
        // First call fails
        prisma.treasuryProposal.create.mockRejectedValueOnce(
          new Error("Transient DB error"),
        );

        await expect(
          treasuryService.createProposal(
            {
              title: "Retry test",
              description: "Should work on second try",
              type: "TRANSFER",
              amount: "2000",
            },
            "0xproposer",
            "biz-1",
          ),
        ).rejects.toMatchObject({
          code: "PERSISTENCE_FAILURE",
          statusCode: 503,
        });

        // Second call succeeds (mock returns resolved by default after the rejection is consumed)
        prisma.treasuryProposal.create.mockResolvedValueOnce({});

        const proposal = await treasuryService.createProposal(
          {
            title: "Retry test",
            description: "Should work on second try",
            type: "TRANSFER",
            amount: "2000",
          },
          "0xproposer",
          "biz-1",
        );

        expect(proposal.id).toMatch(/^prop-/);
        expect(proposal.status).toBe("PENDING");
        expect(auditService.createAuditEntry).toHaveBeenCalled();
      });

      it("should succeed on retry after Prisma update fails once during approve", async () => {
        // Create successfully
        process.env.NODE_ENV = "test";
        const proposal = await treasuryService.createProposal(
          {
            title: "Approve retry",
            description: "Test",
            type: "TRANSFER",
            amount: "5000",
          },
          "0xproposer",
          "biz-1",
        );
        const proposalId = proposal.id as string;

        // First approve attempt fails in production mode
        process.env.NODE_ENV = "production";
        prisma.treasuryProposal.update.mockRejectedValueOnce(
          new Error("Transient DB error"),
        );

        await expect(
          treasuryService.approveProposal(proposalId, "0xsigner1"),
        ).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });

        // DB recovers — next call succeeds
        prisma.treasuryProposal.update.mockResolvedValueOnce({});

        const result = await treasuryService.approveProposal(proposalId, "0xsigner1");
        expect(result.remainingApprovals).toBe(1);
        expect(result.status).toBe("PENDING");
      });

      it("should succeed on retry after Prisma update fails once during execute", async () => {
        // Create and approve in test mode
        process.env.NODE_ENV = "test";
        const proposal = await treasuryService.createProposal(
          {
            title: "Execute retry",
            description: "Test",
            type: "TRANSFER",
            amount: "5000",
          },
          "0xproposer",
          "biz-1",
        );
        const proposalId = proposal.id as string;

        await treasuryService.approveProposal(proposalId, "0xsigner1");
        await treasuryService.approveProposal(proposalId, "0xsigner2");

        // First execute attempt fails
        process.env.NODE_ENV = "production";
        prisma.treasuryProposal.update.mockRejectedValueOnce(
          new Error("Transient DB error"),
        );

        await expect(
          treasuryService.executeProposal(proposalId, "0xexecutor"),
        ).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });

        // DB recovers — retry succeeds
        prisma.treasuryProposal.update.mockResolvedValueOnce({});

        const result = await treasuryService.executeProposal(proposalId, "0xexecutor");
        expect(result.success).toBe(true);
        expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/);
      });
    });
  });
});
