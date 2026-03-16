import {
  createMockRequest,
  createMockResponse,
  createMockNext,
  resetAllMocks,
  VALID_ETH_ADDRESS,
  VALID_ETH_ADDRESS_2,
  VALID_BYTES32,
} from "../setup";
import {
  validate,
  CreatePaymentSchema,
  ListPaymentsSchema,
  BatchPaymentSchema,
  CreateBusinessSchema,
  UpdateBusinessSchema,
  ComplianceScreeningSchema,
  ReviewDecisionSchema,
  ListAuditSchema,
  AuditExportSchema,
} from "../../middleware/validation";

beforeEach(() => {
  resetAllMocks();
});

describe("Validation Middleware", () => {
  // ─── validate() factory ────────────────────────────────────────────────────

  describe("validate()", () => {
    it("should call next when validation passes", () => {
      const middleware = validate(CreatePaymentSchema);
      const req = createMockRequest({
        body: {
          sender: VALID_ETH_ADDRESS,
          recipient: VALID_ETH_ADDRESS_2,
          amount: "100.50",
          currency: "USDC",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 400 with validation errors when validation fails", () => {
      const middleware = validate(CreatePaymentSchema);
      const req = createMockRequest({ body: {} });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: expect.any(Array),
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("should validate query params when source is 'query'", () => {
      const middleware = validate(ListPaymentsSchema, "query");
      const req = createMockRequest({
        query: { page: "1", limit: "10", sortOrder: "desc" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.query.page).toBe(1); // Coerced to number
    });

    it("should replace source data with parsed values", () => {
      const middleware = validate(ListPaymentsSchema, "query");
      const req = createMockRequest({
        query: { page: "3", limit: "50" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(req.query.page).toBe(3);
      expect(req.query.limit).toBe(50);
      expect(req.query.sortOrder).toBe("desc"); // default
    });
  });

  // ─── CreatePaymentSchema ───────────────────────────────────────────────────

  describe("CreatePaymentSchema", () => {
    const validPayment = {
      sender: VALID_ETH_ADDRESS,
      recipient: VALID_ETH_ADDRESS_2,
      amount: "1000.50",
      currency: "USDC",
    };

    it("should accept valid payment data", () => {
      const result = CreatePaymentSchema.safeParse(validPayment);
      expect(result.success).toBe(true);
    });

    it("should reject invalid Ethereum address", () => {
      const result = CreatePaymentSchema.safeParse({
        ...validPayment,
        sender: "not-an-address",
      });
      expect(result.success).toBe(false);
    });

    it("should reject zero amount", () => {
      const result = CreatePaymentSchema.safeParse({
        ...validPayment,
        amount: "0",
      });
      expect(result.success).toBe(false);
    });

    it("should reject negative amount", () => {
      const result = CreatePaymentSchema.safeParse({
        ...validPayment,
        amount: "-100",
      });
      expect(result.success).toBe(false);
    });

    it("should reject lowercase currency", () => {
      const result = CreatePaymentSchema.safeParse({
        ...validPayment,
        currency: "usdc",
      });
      expect(result.success).toBe(false);
    });

    it("should accept optional purposeHash", () => {
      const result = CreatePaymentSchema.safeParse({
        ...validPayment,
        purposeHash: VALID_BYTES32,
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid purposeHash", () => {
      const result = CreatePaymentSchema.safeParse({
        ...validPayment,
        purposeHash: "0xinvalid",
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── ListPaymentsSchema ────────────────────────────────────────────────────

  describe("ListPaymentsSchema", () => {
    it("should apply defaults", () => {
      const result = ListPaymentsSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
        expect(result.data.sortOrder).toBe("desc");
      }
    });

    it("should accept valid status filter", () => {
      const result = ListPaymentsSchema.safeParse({ status: "PENDING" });
      expect(result.success).toBe(true);
    });

    it("should reject invalid status", () => {
      const result = ListPaymentsSchema.safeParse({ status: "INVALID" });
      expect(result.success).toBe(false);
    });

    it("should reject limit > 100", () => {
      const result = ListPaymentsSchema.safeParse({ limit: 101 });
      expect(result.success).toBe(false);
    });

    it("should reject page < 1", () => {
      const result = ListPaymentsSchema.safeParse({ page: 0 });
      expect(result.success).toBe(false);
    });
  });

  // ─── BatchPaymentSchema ────────────────────────────────────────────────────

  describe("BatchPaymentSchema", () => {
    it("should accept array of valid payments", () => {
      const result = BatchPaymentSchema.safeParse({
        payments: [
          {
            sender: VALID_ETH_ADDRESS,
            recipient: VALID_ETH_ADDRESS_2,
            amount: "100",
            currency: "USDC",
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("should reject empty payments array", () => {
      const result = BatchPaymentSchema.safeParse({ payments: [] });
      expect(result.success).toBe(false);
    });
  });

  // ─── CreateBusinessSchema ──────────────────────────────────────────────────

  describe("CreateBusinessSchema", () => {
    const validBusiness = {
      address: VALID_ETH_ADDRESS,
      licenseNumber: "LIC-001",
      businessName: "Test Corp",
      jurisdiction: "UAE",
      businessType: "Fintech",
      contactEmail: "test@example.com",
    };

    it("should accept valid business data", () => {
      const result = CreateBusinessSchema.safeParse(validBusiness);
      expect(result.success).toBe(true);
    });

    it("should reject invalid email", () => {
      const result = CreateBusinessSchema.safeParse({
        ...validBusiness,
        contactEmail: "not-an-email",
      });
      expect(result.success).toBe(false);
    });

    it("should reject empty businessName", () => {
      const result = CreateBusinessSchema.safeParse({
        ...validBusiness,
        businessName: "",
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── UpdateBusinessSchema ──────────────────────────────────────────────────

  describe("UpdateBusinessSchema", () => {
    it("should accept partial updates", () => {
      const result = UpdateBusinessSchema.safeParse({
        businessName: "New Name",
      });
      expect(result.success).toBe(true);
    });

    it("should accept empty object", () => {
      const result = UpdateBusinessSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("should reject invalid email", () => {
      const result = UpdateBusinessSchema.safeParse({
        contactEmail: "bad-email",
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── ComplianceScreeningSchema ─────────────────────────────────────────────

  describe("ComplianceScreeningSchema", () => {
    it("should accept valid screening request", () => {
      const result = ComplianceScreeningSchema.safeParse({
        paymentId: "550e8400-e29b-41d4-a716-446655440000",
        priority: "high",
      });
      expect(result.success).toBe(true);
    });

    it("should default priority to normal", () => {
      const result = ComplianceScreeningSchema.safeParse({
        paymentId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.priority).toBe("normal");
      }
    });

    it("should reject invalid UUID", () => {
      const result = ComplianceScreeningSchema.safeParse({
        paymentId: "not-a-uuid",
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid priority", () => {
      const result = ComplianceScreeningSchema.safeParse({
        paymentId: "550e8400-e29b-41d4-a716-446655440000",
        priority: "invalid",
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── ReviewDecisionSchema ──────────────────────────────────────────────────

  describe("ReviewDecisionSchema", () => {
    it("should accept valid review decision", () => {
      const result = ReviewDecisionSchema.safeParse({
        decision: "approve",
        reason: "Cleared after investigation",
        reviewerAddress: VALID_ETH_ADDRESS,
      });
      expect(result.success).toBe(true);
    });

    it("should reject missing reason", () => {
      const result = ReviewDecisionSchema.safeParse({
        decision: "approve",
        reviewerAddress: VALID_ETH_ADDRESS,
      });
      expect(result.success).toBe(false);
    });

    it("should reject invalid decision value", () => {
      const result = ReviewDecisionSchema.safeParse({
        decision: "maybe",
        reason: "Not sure",
        reviewerAddress: VALID_ETH_ADDRESS,
      });
      expect(result.success).toBe(false);
    });
  });

  // ─── AuditExportSchema ─────────────────────────────────────────────────────

  describe("AuditExportSchema", () => {
    it("should accept valid export request", () => {
      const result = AuditExportSchema.safeParse({
        format: "json",
        from: "2024-01-01T00:00:00Z",
        to: "2024-03-31T23:59:59Z",
      });
      expect(result.success).toBe(true);
    });

    it("should default format to json", () => {
      const result = AuditExportSchema.safeParse({
        from: "2024-01-01T00:00:00Z",
        to: "2024-03-31T23:59:59Z",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.format).toBe("json");
      }
    });

    it("should default includeMetadata to false", () => {
      const result = AuditExportSchema.safeParse({
        from: "2024-01-01T00:00:00Z",
        to: "2024-03-31T23:59:59Z",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.includeMetadata).toBe(false);
      }
    });

    it("should reject invalid date format", () => {
      const result = AuditExportSchema.safeParse({
        from: "not-a-date",
        to: "2024-03-31T23:59:59Z",
      });
      expect(result.success).toBe(false);
    });
  });
});
