const mockAIService = {
  getModels: jest.fn(),
  getModel: jest.fn(),
  getAnalytics: jest.fn(),
  getBiasMetrics: jest.fn(),
  getHumanReviewQueue: jest.fn(),
  listAppeals: jest.fn(),
  resolveAppeal: jest.fn(),
  runDecision: jest.fn(),
  listDecisions: jest.fn(),
  getDecision: jest.fn(),
  overrideDecision: jest.fn(),
  submitAppeal: jest.fn(),
};
let authenticated = true;
let signerId: string | undefined = "0x1111111111111111111111111111111111111111";

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/ai-compliance", () => {
  class AIComplianceError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    AIComplianceService: jest.fn(() => mockAIService),
    AIComplianceError,
  };
});
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (req: any, _res: unknown, next: () => void) => {
    if (authenticated) req.businessId = "11111111-1111-4111-8111-111111111111";
    req.signerId = signerId;
    req.jwtPayload = { sub: "jwt-user" };
    next();
  },
}));
jest.mock("../../middleware/rbac", () => ({
  extractRole: (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import express from "express";
import request from "supertest";
import router from "../../routes/ai-compliance";
import { AIComplianceError } from "../../services/ai-compliance";

const app = express();
app.use(express.json());
app.use("/v1/ai-compliance", router);

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const SIGNER = "0x1111111111111111111111111111111111111111";
const DECISION_ID = "dec-11111111-1111-4111-8111-111111111111";
const APPEAL_ID = "11111111-1111-4111-8111-111111111111";

describe("AI compliance routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated = true;
    signerId = SIGNER;
  });

  it("lists and filters durable model records", async () => {
    mockAIService.getModels.mockResolvedValue([{ id: "model-1" }]);
    const response = await request(app).get(
      "/v1/ai-compliance/models?status=ACTIVE",
    );
    expect(response.status).toBe(200);
    expect(mockAIService.getModels).toHaveBeenCalledWith("ACTIVE");
  });

  it("rejects unsupported model query values before the service", async () => {
    const response = await request(app).get(
      "/v1/ai-compliance/models?status=UNKNOWN",
    );
    expect(response.status).toBe(400);
    expect(mockAIService.getModels).not.toHaveBeenCalled();
  });

  it("loads one model after asserting tenant identity", async () => {
    mockAIService.getModel.mockResolvedValue({ id: "model-1" });
    const response = await request(app).get("/v1/ai-compliance/models/model-1");
    expect(response.status).toBe(200);
    expect(mockAIService.getModel).toHaveBeenCalledWith("model-1");
  });

  it.each([
    ["analytics", "getAnalytics"],
    ["bias-metrics", "getBiasMetrics"],
    ["review-queue", "getHumanReviewQueue"],
    ["appeals", "listAppeals"],
  ])("serves tenant-scoped %s", async (path, method) => {
    (mockAIService as any)[method].mockResolvedValue([]);
    const response = await request(app).get(`/v1/ai-compliance/${path}`);
    expect(response.status).toBe(200);
    expect((mockAIService as any)[method]).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("fails read operations closed when tenant identity is absent", async () => {
    authenticated = false;
    const response = await request(app).get("/v1/ai-compliance/analytics");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("TENANT_REQUIRED");
    expect(mockAIService.getAnalytics).not.toHaveBeenCalled();
  });

  it("rejects decision execution without an idempotency key", async () => {
    const response = await request(app)
      .post("/v1/ai-compliance/decisions")
      .send({ modelId: "model-1", paymentId: "payment-1" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(mockAIService.runDecision).not.toHaveBeenCalled();
  });

  it("propagates the explicit fail-closed decision-execution error", async () => {
    mockAIService.runDecision.mockRejectedValue(
      new AIComplianceError(
        "AI_DECISION_VERIFICATION_UNAVAILABLE",
        "verification unavailable",
        501,
      ),
    );
    const response = await request(app)
      .post("/v1/ai-compliance/decisions")
      .set("Idempotency-Key", "decision-key-001")
      .send({ modelId: "model-1", paymentId: "payment-1" });
    expect(response.status).toBe(501);
    expect(response.body.error).toBe("AI_DECISION_VERIFICATION_UNAVAILABLE");
    expect(mockAIService.runDecision).toHaveBeenCalledWith(
      "model-1",
      "payment-1",
      BUSINESS_ID,
      "decision-key-001",
    );
  });

  it("rejects malformed decision execution bodies", async () => {
    const response = await request(app)
      .post("/v1/ai-compliance/decisions")
      .set("Idempotency-Key", "decision-key-001")
      .send({ modelId: "", paymentId: "payment-1", extra: true });
    expect(response.status).toBe(400);
    expect(mockAIService.runDecision).not.toHaveBeenCalled();
  });

  it("lists decisions with normalized filters and a default limit", async () => {
    mockAIService.listDecisions.mockResolvedValue([]);
    const response = await request(app).get(
      "/v1/ai-compliance/decisions?modelId=model-1&paymentId=payment-1&outcome=FLAG",
    );
    expect(response.status).toBe(200);
    expect(mockAIService.listDecisions).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      modelId: "model-1",
      paymentId: "payment-1",
      outcome: "FLAG",
      limit: 50,
    });
  });

  it("loads one tenant-owned decision", async () => {
    mockAIService.getDecision.mockResolvedValue({ id: DECISION_ID });
    const response = await request(app).get(
      `/v1/ai-compliance/decisions/${DECISION_ID}`,
    );
    expect(response.status).toBe(200);
    expect(mockAIService.getDecision).toHaveBeenCalledWith(
      DECISION_ID,
      BUSINESS_ID,
    );
  });

  it("rejects malformed decision identifiers", async () => {
    const response = await request(app).get(
      "/v1/ai-compliance/decisions/not-valid",
    );
    expect(response.status).toBe(400);
    expect(mockAIService.getDecision).not.toHaveBeenCalled();
  });

  it("passes a verified actor to an override and preserves its 501 error", async () => {
    mockAIService.overrideDecision.mockRejectedValue(
      new AIComplianceError(
        "AI_DECISION_MUTATIONS_UNAVAILABLE",
        "mutation unavailable",
        501,
      ),
    );
    const response = await request(app)
      .post(`/v1/ai-compliance/decisions/${DECISION_ID}/override`)
      .send({
        outcome: "APPROVE",
        reason: "Confirmed false positive evidence",
      });
    expect(response.status).toBe(501);
    expect(mockAIService.overrideDecision).toHaveBeenCalledWith(
      DECISION_ID,
      "APPROVE",
      SIGNER,
      "Confirmed false positive evidence",
      BUSINESS_ID,
    );
  });

  it("falls back to the signed JWT subject when signerId is unavailable", async () => {
    signerId = undefined;
    mockAIService.submitAppeal.mockRejectedValue(
      new AIComplianceError(
        "AI_APPEAL_VERIFICATION_UNAVAILABLE",
        "appeal unavailable",
        501,
      ),
    );
    const response = await request(app)
      .post(`/v1/ai-compliance/decisions/${DECISION_ID}/appeals`)
      .send({ reason: "Additional transaction evidence is available" });
    expect(response.status).toBe(501);
    expect(mockAIService.submitAppeal).toHaveBeenCalledWith(
      DECISION_ID,
      "jwt-user",
      "Additional transaction evidence is available",
      BUSINESS_ID,
    );
  });

  it("requires a final outcome when resolving an overturned appeal", async () => {
    const response = await request(app)
      .post(`/v1/ai-compliance/appeals/${APPEAL_ID}/resolve`)
      .send({
        outcome: "OVERTURNED",
        reviewNotes: "The appeal evidence changes the outcome",
      });
    expect(response.status).toBe(400);
    expect(mockAIService.resolveAppeal).not.toHaveBeenCalled();
  });

  it("passes complete appeal resolution evidence to the service", async () => {
    mockAIService.resolveAppeal.mockRejectedValue(
      new AIComplianceError(
        "AI_APPEAL_VERIFICATION_UNAVAILABLE",
        "appeal unavailable",
        501,
      ),
    );
    const response = await request(app)
      .post(`/v1/ai-compliance/appeals/${APPEAL_ID}/resolve`)
      .send({
        outcome: "OVERTURNED",
        reviewNotes: "The appeal evidence changes the outcome",
        finalOutcome: "APPROVE",
      });
    expect(response.status).toBe(501);
    expect(mockAIService.resolveAppeal).toHaveBeenCalledWith(
      APPEAL_ID,
      SIGNER,
      "OVERTURNED",
      "The appeal evidence changes the outcome",
      BUSINESS_ID,
      "APPROVE",
    );
  });

  it("maps unexpected service failures to a generic response", async () => {
    mockAIService.getModels.mockRejectedValue(new Error("database password"));
    const response = await request(app).get("/v1/ai-compliance/models");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "INTERNAL_ERROR",
      message: "An internal error occurred",
    });
    expect(JSON.stringify(response.body)).not.toContain("password");
  });
});
