import { createMockPrisma, resetAllMocks } from "../setup";
import {
  AIComplianceService,
  AIComplianceError,
} from "../../services/ai-compliance";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let aiService: AIComplianceService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  aiService = new AIComplianceService(prisma, auditService);
});

describe("AIComplianceService", () => {
  // ─── getModels ─────────────────────────────────────────────────────────────

  describe("getModels", () => {
    it("should return all models", () => {
      const models = aiService.getModels();
      expect(models.length).toBe(5);
    });

    it("should filter by status", () => {
      const active = aiService.getModels("ACTIVE");
      expect(active.every((m) => m.status === "ACTIVE")).toBe(true);
    });

    it("should return empty for DEPRECATED status", () => {
      const deprecated = aiService.getModels("DEPRECATED");
      expect(deprecated).toHaveLength(0);
    });
  });

  // ─── getModel ──────────────────────────────────────────────────────────────

  describe("getModel", () => {
    it("should return a model by ID", () => {
      const model = aiService.getModel("model-sanctions-v3");
      expect(model.name).toBe("SanctionsBERT");
      expect(model.teeAttested).toBe(true);
    });

    it("should throw MODEL_NOT_FOUND for unknown ID", () => {
      expect(() => aiService.getModel("nonexistent")).toThrow(
        AIComplianceError,
      );
    });
  });

  // ─── recordDecision ────────────────────────────────────────────────────────

  describe("recordDecision", () => {
    it("should record an APPROVE decision", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "APPROVE",
        0.95,
        [{ name: "sanctions_check", contribution: 0.9, value: "clear" }],
        "Payment cleared by sanctions screening",
        15,
      );

      expect(decision.id).toMatch(/^dec-/);
      expect(decision.outcome).toBe("APPROVE");
      expect(decision.confidence).toBe(0.95);
      expect(decision.teeAttestation).toMatch(/^0x/);
      expect(decision.humanOverride).toBe(false);
    });

    it("should auto-escalate low confidence non-approve decisions", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.5, // Below 0.7 threshold
        [],
        "Low confidence flag",
        10,
      );

      expect(decision.outcome).toBe("ESCALATE");
    });

    it("should NOT auto-escalate low confidence APPROVE decisions", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "APPROVE",
        0.5,
        [],
        "Low confidence approve",
        10,
      );

      expect(decision.outcome).toBe("APPROVE");
    });

    it("should increment model totalDecisions", async () => {
      const before = aiService.getModel("model-sanctions-v3").totalDecisions;

      await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "APPROVE",
        0.9,
        [],
        "Test",
        5,
      );

      const after = aiService.getModel("model-sanctions-v3").totalDecisions;
      expect(after).toBe(before + 1);
    });

    it("should throw MODEL_NOT_FOUND for unknown model", async () => {
      await expect(
        aiService.recordDecision(
          "nonexistent",
          "pay-1",
          "APPROVE",
          0.9,
          [],
          "Test",
          5,
        ),
      ).rejects.toThrow(AIComplianceError);
    });
  });

  // ─── overrideDecision ──────────────────────────────────────────────────────

  describe("overrideDecision", () => {
    it("should override a decision", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.85,
        [],
        "Flagged",
        10,
      );

      const overridden = await aiService.overrideDecision(
        decision.id,
        "APPROVE",
        "0xreviewer",
        "False positive confirmed",
      );

      expect(overridden.humanOverride).toBe(true);
      expect(overridden.overrideBy).toBe("0xreviewer");
      expect(overridden.overrideReason).toBe("False positive confirmed");
      expect(overridden.outcome).toBe("APPROVE");
    });

    it("should throw DECISION_NOT_FOUND for unknown decision", async () => {
      await expect(
        aiService.overrideDecision(
          "nonexistent",
          "APPROVE",
          "0xreviewer",
          "reason",
        ),
      ).rejects.toMatchObject({ code: "DECISION_NOT_FOUND" });
    });
  });

  // ─── submitAppeal ──────────────────────────────────────────────────────────

  describe("submitAppeal", () => {
    it("should submit an appeal against a decision", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "BLOCK",
        0.92,
        [],
        "Blocked",
        8,
      );

      const appeal = await aiService.submitAppeal(
        decision.id,
        "0xsubmitter",
        "Legitimate transaction misidentified",
      );

      expect(appeal.id).toMatch(/^appeal-/);
      expect(appeal.status).toBe("SUBMITTED");
      expect(appeal.originalOutcome).toBe("BLOCK");
      expect(appeal.finalOutcome).toBeNull();
    });

    it("should throw DECISION_NOT_FOUND for unknown decision", async () => {
      await expect(
        aiService.submitAppeal("nonexistent", "0xsubmitter", "reason"),
      ).rejects.toMatchObject({ code: "DECISION_NOT_FOUND" });
    });
  });

  // ─── getHumanReviewQueue ───────────────────────────────────────────────────

  describe("getHumanReviewQueue", () => {
    it("should return escalated decisions not yet overridden", async () => {
      await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.5, // Will be auto-escalated
        [],
        "Low confidence",
        10,
      );

      const queue = aiService.getHumanReviewQueue();
      expect(queue.length).toBeGreaterThan(0);
      expect(queue.every((d) => d.outcome === "ESCALATE")).toBe(true);
      expect(queue.every((d) => !d.humanOverride)).toBe(true);
    });

    it("should sort by createdAt ascending", async () => {
      await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.5,
        [],
        "First escalated",
        10,
      );
      await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-2",
        "FLAG",
        0.4,
        [],
        "Second escalated",
        10,
      );

      const queue = aiService.getHumanReviewQueue();
      expect(queue.length).toBeGreaterThanOrEqual(2);
      // Should be sorted ascending by createdAt
      for (let i = 1; i < queue.length; i++) {
        expect(queue[i - 1].createdAt.getTime()).toBeLessThanOrEqual(queue[i].createdAt.getTime());
      }
    });

    it("should not include overridden decisions", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.5,
        [],
        "Low confidence",
        10,
      );

      await aiService.overrideDecision(
        decision.id,
        "APPROVE",
        "0xreviewer",
        "Cleared",
      );

      const queue = aiService.getHumanReviewQueue();
      const found = queue.find((d) => d.id === decision.id);
      expect(found).toBeUndefined();
    });
  });

  // ─── getBiasMetrics ────────────────────────────────────────────────────────

  describe("getBiasMetrics", () => {
    it("should return metrics for all jurisdictions", () => {
      const metrics = aiService.getBiasMetrics();
      expect(metrics.length).toBe(8);
      expect(metrics[0]).toHaveProperty("jurisdiction");
      expect(metrics[0]).toHaveProperty("flagRate");
      expect(metrics[0]).toHaveProperty("deviationFromGlobal");
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return analytics with no decisions", () => {
      const analytics = aiService.getAnalytics();
      expect(analytics.activeModels).toBe(5);
      expect(analytics.totalDecisions).toBe(0);
      expect(analytics.avgConfidence).toBe(0);
      expect(analytics.modelPerformance.length).toBe(5);
    });

    it("should calculate analytics with decisions", async () => {
      await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "APPROVE",
        0.95,
        [],
        "Approved",
        15,
      );

      const analytics = aiService.getAnalytics();
      expect(analytics.totalDecisions).toBe(1);
      expect(analytics.avgConfidence).toBe(0.95);
      expect(analytics.avgProcessingTime).toBe(15);
    });

    it("should calculate escalation rate", async () => {
      // Record an escalated decision (FLAG with low confidence auto-escalates)
      await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.5,
        [],
        "Low confidence flag",
        10,
      );

      const analytics = aiService.getAnalytics();
      expect(analytics.escalationRate).toBeGreaterThan(0);
    });

    it("should calculate human override rate", async () => {
      // Record a decision and override it
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "FLAG",
        0.85,
        [],
        "Flagged",
        10,
      );

      await aiService.overrideDecision(
        decision.id,
        "APPROVE",
        "0xreviewer",
        "False positive",
      );

      const analytics = aiService.getAnalytics();
      expect(analytics.humanOverrideRate).toBeGreaterThan(0);
    });

    it("should calculate appeal overturn rate", async () => {
      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-1",
        "BLOCK",
        0.92,
        [],
        "Blocked",
        8,
      );

      await aiService.submitAppeal(
        decision.id,
        "0xsubmitter",
        "False positive",
      );

      const analytics = aiService.getAnalytics();
      expect(analytics.appealRate).toBeGreaterThan(0);
      // appealOverturnRate will be 0 since status is SUBMITTED not OVERTURNED
      expect(analytics.appealOverturnRate).toBe(0);
    });
  });

  // ─── recordDecision (teeAttestation null branch) ─────────────────────────

  describe("recordDecision (non-TEE model)", () => {
    it("should set teeAttestation to null when model.teeAttested is false", async () => {
      // Get a model and temporarily set teeAttested to false
      const model = aiService.getModel("model-sanctions-v3");
      const originalTeeAttested = model.teeAttested;
      (model as any).teeAttested = false;

      const decision = await aiService.recordDecision(
        "model-sanctions-v3",
        "pay-tee-test",
        "APPROVE",
        0.95,
        [],
        "Testing non-TEE model",
        10,
      );

      expect(decision.teeAttestation).toBeNull();

      // Restore
      (model as any).teeAttested = originalTeeAttested;
    });
  });

  // ─── AIComplianceError ─────────────────────────────────────────────────────

  describe("AIComplianceError", () => {
    it("should set properties correctly", () => {
      const err = new AIComplianceError("CODE", "msg", 404);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe("AIComplianceError");
    });

    it("should default statusCode to 400", () => {
      const err = new AIComplianceError("CODE", "msg");
      expect(err.statusCode).toBe(400);
    });
  });
});
