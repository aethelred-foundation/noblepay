/**
 * Treasury Persistence Chaos Tests
 *
 * Simulates database outages during treasury operations and verifies that:
 * - The service returns 503 PERSISTENCE_FAILURE (never 404) when the DB is down
 * - In-memory state is never mutated when persistence fails
 * - Recovery after DB returns yields consistent state
 */
import { createMockPrisma, resetAllMocks } from "../setup";
import { TreasuryService, TreasuryError } from "../../services/treasury";
import { AuditService } from "../../services/audit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let treasuryService: TreasuryService;
let originalNodeEnv: string | undefined;

/**
 * Creates a proposal in-memory AND in the mock DB so that it can be
 * looked up via both paths. We run this while NODE_ENV=test so that
 * the create path uses the in-memory fallback (Prisma mock `.create`
 * does not throw). Then we flip NODE_ENV to "production" for the
 * chaos portion of each test.
 */
async function seedProposal(
  opts: {
    amount?: string;
    approvers?: string[];
    status?: string;
  } = {},
) {
  // Ensure create goes through (NODE_ENV=test => in-memory fallback on Prisma failure)
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";

  const proposal = await treasuryService.createProposal(
    {
      title: "Chaos test proposal",
      description: "Used by chaos test suite",
      type: "TRANSFER",
      amount: opts.amount ?? "5000",
      currency: "USDC",
    },
    "0xproposer",
    "biz-chaos",
  );

  const proposalId = proposal.id as string;

  // If we need approvers, add them while still in test mode
  if (opts.approvers) {
    for (const signer of opts.approvers) {
      await treasuryService.approveProposal(proposalId, signer);
    }
  }

  process.env.NODE_ENV = prevEnv;
  return { proposalId, proposal };
}

function dbConnectionError() {
  const err = new Error(
    "Can't reach database server at `db.example.com`:`5432`",
  );
  (err as any).code = "P1001";
  return err;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  resetAllMocks();
  originalNodeEnv = process.env.NODE_ENV;

  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  treasuryService = new TreasuryService(prisma, auditService);
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Treasury Persistence Chaos", () => {
  // ─── DB Outage During Proposal Restore ────────────────────────────────────

  describe("DB outage during proposal restore", () => {
    it("should return 503 PERSISTENCE_FAILURE, not 404 PROPOSAL_NOT_FOUND", async () => {
      // The proposal exists in the DB but NOT in memory.
      // Simulate: findUnique throws a connection error.
      process.env.NODE_ENV = "production";

      prisma.treasuryProposal.findUnique.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.approveProposal("prop-abc123", "0xsigner"),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_FAILURE",
        statusCode: 503,
      });
    });

    it("should NOT create any in-memory state on DB failure", async () => {
      process.env.NODE_ENV = "production";

      prisma.treasuryProposal.findUnique.mockRejectedValueOnce(
        dbConnectionError(),
      );

      try {
        await treasuryService.approveProposal("prop-ghost", "0xsigner");
      } catch {
        // expected
      }

      // Now let findUnique return null (proposal does not exist in-memory)
      // If a ghost entry was created, the next call would find it in memory
      // and NOT hit Prisma at all.
      prisma.treasuryProposal.findUnique.mockResolvedValueOnce(null);

      await expect(
        treasuryService.approveProposal("prop-ghost", "0xsigner"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_NOT_FOUND",
        statusCode: 404,
      });
    });
  });

  // ─── DB Outage During Approval ────────────────────────────────────────────

  describe("DB outage during approval", () => {
    it("should return 503 PERSISTENCE_FAILURE when update throws", async () => {
      const { proposalId } = await seedProposal();

      // Switch to production mode so persistence failures are not swallowed
      process.env.NODE_ENV = "production";

      // The proposal is already in memory from seedProposal, so findUnique
      // will not be called. Mock update to fail.
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.approveProposal(proposalId, "0xsigner-chaos"),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_FAILURE",
        statusCode: 503,
      });
    });

    it("should NOT modify in-memory approvers list on DB failure", async () => {
      const { proposalId } = await seedProposal();

      process.env.NODE_ENV = "production";
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      try {
        await treasuryService.approveProposal(proposalId, "0xsigner-chaos");
      } catch {
        // expected
      }

      // Verify the signer was NOT added — re-approve with the same signer
      // should NOT throw DUPLICATE_APPROVAL.
      // Reset mock so persistence succeeds this time.
      prisma.treasuryProposal.update.mockResolvedValueOnce({});
      const result = await treasuryService.approveProposal(
        proposalId,
        "0xsigner-chaos",
      );

      expect(result).toHaveProperty("approved");
      // The signer was accepted, confirming it was not already in the list
    });

    it("should NOT change in-memory proposal status on DB failure", async () => {
      // Use amount < 10000 => requires 2 approvals
      const { proposalId } = await seedProposal({ approvers: ["0xsigner1"] });

      process.env.NODE_ENV = "production";

      // The second approval would flip status to APPROVED, but DB fails
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      try {
        await treasuryService.approveProposal(proposalId, "0xsigner2");
      } catch {
        // expected
      }

      // Status should still be PENDING (not APPROVED)
      // Retry with working DB — if status had been flipped to APPROVED,
      // the service would throw INVALID_STATE ("expected PENDING").
      prisma.treasuryProposal.update.mockResolvedValueOnce({});
      const result = await treasuryService.approveProposal(
        proposalId,
        "0xsigner2",
      );

      expect(result.approved).toBe(true);
      expect(result.status).toBe("APPROVED");
    });
  });

  // ─── DB Outage During Execution ───────────────────────────────────────────

  describe("DB outage during execution", () => {
    it("should return 503 PERSISTENCE_FAILURE when update throws", async () => {
      // amount < 10000 => 2 approvals, 0 timelock
      const { proposalId } = await seedProposal({
        approvers: ["0xsigner1", "0xsigner2"],
      });

      process.env.NODE_ENV = "production";
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.executeProposal(proposalId, "0xexecutor"),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_FAILURE",
        statusCode: 503,
      });
    });

    it("should keep in-memory status as APPROVED, not EXECUTED", async () => {
      const { proposalId } = await seedProposal({
        approvers: ["0xsigner1", "0xsigner2"],
      });

      process.env.NODE_ENV = "production";
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      try {
        await treasuryService.executeProposal(proposalId, "0xexecutor");
      } catch {
        // expected
      }

      // If status was mutated to EXECUTED, retrying would throw
      // INVALID_STATE ("expected APPROVED"). A successful retry confirms
      // the in-memory status is still APPROVED.
      prisma.treasuryProposal.update.mockResolvedValueOnce({});
      const result = await treasuryService.executeProposal(
        proposalId,
        "0xexecutor",
      );

      expect(result.success).toBe(true);
      expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/);
    });
  });

  // ─── Recovery After DB Returns ────────────────────────────────────────────

  describe("recovery after DB returns", () => {
    it("should succeed on second attempt after DB comes back", async () => {
      const { proposalId } = await seedProposal();

      process.env.NODE_ENV = "production";

      // First attempt: DB down
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.approveProposal(proposalId, "0xrecovery-signer"),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_FAILURE",
        statusCode: 503,
      });

      // Second attempt: DB recovered
      prisma.treasuryProposal.update.mockResolvedValueOnce({});

      const result = await treasuryService.approveProposal(
        proposalId,
        "0xrecovery-signer",
      );

      expect(result).toHaveProperty("approved");
      expect(result).toHaveProperty("remainingApprovals");
      expect(result).toHaveProperty("status");
    });

    it("should have consistent state between memory and DB mock after recovery", async () => {
      const { proposalId } = await seedProposal({
        approvers: ["0xsigner1"],
      });

      process.env.NODE_ENV = "production";

      // First: DB outage during the final approval
      prisma.treasuryProposal.update.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.approveProposal(proposalId, "0xsigner2"),
      ).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });

      // Second: DB recovered — capture the data passed to Prisma update
      let persistedData: any = null;
      prisma.treasuryProposal.update.mockImplementationOnce(
        async (args: any) => {
          persistedData = args.data;
          return {};
        },
      );

      const result = await treasuryService.approveProposal(
        proposalId,
        "0xsigner2",
      );

      // In-memory says APPROVED
      expect(result.status).toBe("APPROVED");
      expect(result.approved).toBe(true);

      // The data sent to Prisma should match
      expect(persistedData).not.toBeNull();
      expect(persistedData.status).toBe("APPROVED");
      expect(persistedData.approvedBy).toContain("0xsigner2");
      expect(persistedData.currentSigs).toBe(2);
    });
  });

  // ─── Never 404 on DB Failure ──────────────────────────────────────────────

  describe("never 404 on DB failure", () => {
    it("approveProposal should return 503, not 404, when DB is down and proposal is not in memory", async () => {
      process.env.NODE_ENV = "production";

      prisma.treasuryProposal.findUnique.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.approveProposal("prop-db-only-1", "0xsigner"),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_FAILURE",
        statusCode: 503,
      });
    });

    it("executeProposal should return 503, not 404, when DB is down and proposal is not in memory", async () => {
      process.env.NODE_ENV = "production";

      prisma.treasuryProposal.findUnique.mockRejectedValueOnce(
        dbConnectionError(),
      );

      await expect(
        treasuryService.executeProposal("prop-db-only-2", "0xexecutor"),
      ).rejects.toMatchObject({
        code: "PERSISTENCE_FAILURE",
        statusCode: 503,
      });
    });

    it("should still return 404 when DB is up but proposal genuinely does not exist", async () => {
      process.env.NODE_ENV = "production";

      // DB responds fine — proposal simply does not exist
      prisma.treasuryProposal.findUnique.mockResolvedValueOnce(null);

      await expect(
        treasuryService.approveProposal("prop-nonexistent", "0xsigner"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_NOT_FOUND",
        statusCode: 404,
      });
    });
  });
});
