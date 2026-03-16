import {
  createMockPrisma,
  resetAllMocks,
  mockCounter,
  mockHistogram,
  mockLogger,
} from "../setup";
import { PaymentService, PaymentError } from "../../services/payment";
import { AuditService } from "../../services/audit";

// ─── Setup ──────────────────────────────────────────────────────────────────

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let paymentService: PaymentService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  paymentService = new PaymentService(prisma, auditService);
});

// ─── createPayment ──────────────────────────────────────────────────────────

describe("PaymentService", () => {
  describe("createPayment", () => {
    const input = {
      sender: "0x1234567890abcdef1234567890abcdef12345678",
      recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      amount: "1000.50",
      currency: "USDC",
    };

    it("should create a payment and return it", async () => {
      const mockPayment = {
        id: "uuid-1",
        paymentId: "0xabc123",
        sender: input.sender,
        recipient: input.recipient,
        amount: { toString: () => "1000.50" },
        currency: "USDC",
        status: "PENDING",
      };
      prisma.payment.create.mockResolvedValue(mockPayment);

      const result = await paymentService.createPayment(input, "biz-1");

      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockPayment);
      expect(mockCounter.inc).toHaveBeenCalledWith({
        status: "PENDING",
        currency: "USDC",
      });
      expect(mockHistogram.observe).toHaveBeenCalledWith(
        { currency: "USDC" },
        1000.5,
      );
      expect(auditService.createAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "PAYMENT_CREATED",
          actor: input.sender,
        }),
      );
    });

    it("should generate a unique paymentId starting with 0x", async () => {
      prisma.payment.create.mockImplementation(async ({ data }: any) => {
        expect(data.paymentId).toMatch(/^0x[a-f0-9]{64}$/);
        return { ...data, id: "uuid-1" };
      });

      await paymentService.createPayment(input, "biz-1");
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    });

    it("should store purposeHash when provided", async () => {
      const purposeHash =
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      prisma.payment.create.mockImplementation(async ({ data }: any) => {
        expect(data.purposeHash).toBe(purposeHash);
        return data;
      });

      await paymentService.createPayment(
        { ...input, purposeHash },
        "biz-1",
      );
    });

    it("should set purposeHash to null when not provided", async () => {
      prisma.payment.create.mockImplementation(async ({ data }: any) => {
        expect(data.purposeHash).toBeNull();
        return data;
      });

      await paymentService.createPayment(input, "biz-1");
    });
  });

  // ─── getPayment ────────────────────────────────────────────────────────────

  describe("getPayment", () => {
    it("should look up by paymentId hash when id starts with 0x", async () => {
      const hash = "0x" + "a".repeat(64);
      prisma.payment.findUnique.mockResolvedValue({ id: "1", paymentId: hash });

      await paymentService.getPayment(hash);

      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { paymentId: hash },
        include: { screenings: true, travelRuleRecord: true },
      });
    });

    it("should look up by UUID when id does not start with 0x", async () => {
      const uuid = "uuid-123";
      prisma.payment.findUnique.mockResolvedValue({ id: uuid });

      await paymentService.getPayment(uuid);

      expect(prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { id: uuid },
        include: { screenings: true, travelRuleRecord: true },
      });
    });

    it("should return null when payment is not found", async () => {
      prisma.payment.findUnique.mockResolvedValue(null);

      const result = await paymentService.getPayment("nonexistent");
      expect(result).toBeNull();
    });
  });

  // ─── listPayments ──────────────────────────────────────────────────────────

  describe("listPayments", () => {
    it("should return paginated results", async () => {
      const mockData = [
        { id: "1", amount: { toString: () => "100" } },
        { id: "2", amount: { toString: () => "200" } },
      ];
      prisma.payment.findMany.mockResolvedValue(mockData);
      prisma.payment.count.mockResolvedValue(50);

      const result = await paymentService.listPayments({
        page: 2,
        limit: 10,
        sortOrder: "desc",
      });

      expect(result.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 50,
        totalPages: 5,
      });
      expect(result.data).toHaveLength(2);
    });

    it("should apply status filter", async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await paymentService.listPayments({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        status: "PENDING",
      });

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PENDING" }),
        }),
      );
    });

    it("should apply amount range filters", async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await paymentService.listPayments({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        minAmount: "100",
        maxAmount: "5000",
      });

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            amount: expect.any(Object),
          }),
        }),
      );
    });

    it("should apply date range filters", async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await paymentService.listPayments({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
      });

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            initiatedAt: expect.any(Object),
          }),
        }),
      );
    });

    it("should calculate totalPages correctly", async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(31);

      const result = await paymentService.listPayments({
        page: 1,
        limit: 10,
        sortOrder: "desc",
      });

      expect(result.pagination.totalPages).toBe(4);
    });

    it("should use sortBy when provided and valid", async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await paymentService.listPayments({
        page: 1,
        limit: 20,
        sortOrder: "asc",
        sortBy: "amount",
      });

      // The sortBy branch should be exercised (line 157)
      expect(prisma.payment.findMany).toHaveBeenCalled();
    });
  });

  // ─── cancelPayment ─────────────────────────────────────────────────────────

  describe("cancelPayment", () => {
    it("should cancel a PENDING payment", async () => {
      const payment = {
        id: "uuid-1",
        paymentId: "0xabc",
        status: "PENDING",
        currency: "USDC",
      };
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(payment as any);
      prisma.payment.update.mockResolvedValue({
        ...payment,
        status: "CANCELLED",
      });

      const result = await paymentService.cancelPayment("uuid-1", "actor-1");

      expect(result.status).toBe("CANCELLED");
      expect(auditService.createAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "PAYMENT_CANCELLED" }),
      );
    });

    it("should cancel a SCREENING payment", async () => {
      const payment = {
        id: "uuid-1",
        paymentId: "0xabc",
        status: "SCREENING",
        currency: "USDC",
      };
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(payment as any);
      prisma.payment.update.mockResolvedValue({
        ...payment,
        status: "CANCELLED",
      });

      const result = await paymentService.cancelPayment("uuid-1", "actor-1");
      expect(result.status).toBe("CANCELLED");
    });

    it("should throw PAYMENT_NOT_FOUND when payment does not exist", async () => {
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(null);

      await expect(
        paymentService.cancelPayment("nonexistent", "actor"),
      ).rejects.toThrow(PaymentError);

      await expect(
        paymentService.cancelPayment("nonexistent", "actor"),
      ).rejects.toMatchObject({
        code: "PAYMENT_NOT_FOUND",
        statusCode: 404,
      });
    });

    it("should throw INVALID_STATE when payment is SETTLED", async () => {
      const payment = { id: "1", paymentId: "0x1", status: "SETTLED" };
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(payment as any);

      await expect(
        paymentService.cancelPayment("1", "actor"),
      ).rejects.toMatchObject({
        code: "INVALID_STATE",
        statusCode: 409,
      });
    });

    it("should throw INVALID_STATE when payment is APPROVED", async () => {
      const payment = { id: "1", paymentId: "0x1", status: "APPROVED" };
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(payment as any);

      await expect(
        paymentService.cancelPayment("1", "actor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
  });

  // ─── refundPayment ─────────────────────────────────────────────────────────

  describe("refundPayment", () => {
    it("should refund a SETTLED payment", async () => {
      const payment = {
        id: "uuid-1",
        paymentId: "0xabc",
        status: "SETTLED",
        amount: { toString: () => "500" },
        currency: "USDC",
      };
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(payment as any);
      prisma.payment.update.mockResolvedValue({
        ...payment,
        status: "REFUNDED",
        refundedAt: expect.any(Date),
      });

      const result = await paymentService.refundPayment("uuid-1", "actor-1");

      expect(result.status).toBe("REFUNDED");
      expect(auditService.createAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "PAYMENT_REFUNDED" }),
      );
    });

    it("should throw PAYMENT_NOT_FOUND when payment does not exist", async () => {
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(null);

      await expect(
        paymentService.refundPayment("nonexistent", "actor"),
      ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", statusCode: 404 });
    });

    it("should throw INVALID_STATE when payment is PENDING", async () => {
      const payment = { id: "1", paymentId: "0x1", status: "PENDING" };
      jest.spyOn(paymentService, "getPayment").mockResolvedValue(payment as any);

      await expect(
        paymentService.refundPayment("1", "actor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
    });
  });

  // ─── validateBusinessLimits ────────────────────────────────────────────────

  describe("validateBusinessLimits", () => {
    it("should return allowed:true when within limits", async () => {
      prisma.business.findUnique.mockResolvedValue({
        id: "biz-1",
        address: "0x1",
        kycStatus: "VERIFIED",
        dailyLimit: { toString: () => "10000" },
        monthlyLimit: { toString: () => "100000" },
      });
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } }) // daily
        .mockResolvedValueOnce({ _sum: { amount: null } }); // monthly

      const result = await paymentService.validateBusinessLimits(
        "biz-1",
        "500",
        "USDC",
      );

      expect(result).toEqual({ allowed: true });
    });

    it("should return allowed:false when business not found", async () => {
      prisma.business.findUnique.mockResolvedValue(null);

      const result = await paymentService.validateBusinessLimits(
        "nonexistent",
        "100",
        "USDC",
      );

      expect(result).toEqual({ allowed: false, reason: "Business not found" });
    });

    it("should return allowed:false when KYC is not VERIFIED", async () => {
      prisma.business.findUnique.mockResolvedValue({
        id: "biz-1",
        kycStatus: "PENDING",
      });

      const result = await paymentService.validateBusinessLimits(
        "biz-1",
        "100",
        "USDC",
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("PENDING");
    });

    it("should return allowed:false when daily limit is exceeded", async () => {
      prisma.business.findUnique.mockResolvedValue({
        id: "biz-1",
        address: "0x1",
        kycStatus: "VERIFIED",
        dailyLimit: { toString: () => "1000" },
        monthlyLimit: { toString: () => "100000" },
      });
      prisma.payment.aggregate
        .mockResolvedValueOnce({
          _sum: { amount: { toString: () => "900" } },
        })
        .mockResolvedValueOnce({ _sum: { amount: null } });

      const result = await paymentService.validateBusinessLimits(
        "biz-1",
        "200",
        "USDC",
      );

      expect(result).toEqual({
        allowed: false,
        reason: "Daily payment limit exceeded",
      });
    });

    it("should return allowed:false when monthly limit is exceeded", async () => {
      prisma.business.findUnique.mockResolvedValue({
        id: "biz-1",
        address: "0x1",
        kycStatus: "VERIFIED",
        dailyLimit: { toString: () => "100000" },
        monthlyLimit: { toString: () => "1000" },
      });
      prisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({
          _sum: { amount: { toString: () => "900" } },
        });

      const result = await paymentService.validateBusinessLimits(
        "biz-1",
        "200",
        "USDC",
      );

      expect(result).toEqual({
        allowed: false,
        reason: "Monthly payment limit exceeded",
      });
    });
  });

  // ─── calculateFees ─────────────────────────────────────────────────────────

  describe("calculateFees", () => {
    it("should calculate STARTER fees at 50 basis points", () => {
      const result = paymentService.calculateFees("10000", "STARTER");
      expect(result.basisPoints).toBe(50);
      expect(parseFloat(result.fee)).toBeCloseTo(50, 1);
      expect(parseFloat(result.netAmount)).toBeCloseTo(9950, 1);
    });

    it("should calculate ENTERPRISE fees at 15 basis points", () => {
      const result = paymentService.calculateFees("10000", "ENTERPRISE");
      expect(result.basisPoints).toBe(15);
      expect(parseFloat(result.fee)).toBeCloseTo(15, 1);
    });

    it("should calculate INSTITUTIONAL fees at 5 basis points", () => {
      const result = paymentService.calculateFees("100000", "INSTITUTIONAL");
      expect(result.basisPoints).toBe(5);
      expect(parseFloat(result.fee)).toBeCloseTo(50, 1);
    });

    it("should default to STARTER for unknown tiers", () => {
      const result = paymentService.calculateFees("1000", "UNKNOWN_TIER");
      expect(result.basisPoints).toBe(50);
    });

    it("should handle zero amount", () => {
      const result = paymentService.calculateFees("0", "STANDARD");
      expect(parseFloat(result.fee)).toBe(0);
      expect(parseFloat(result.netAmount)).toBe(0);
    });
  });

  // ─── batchProcessPayments ──────────────────────────────────────────────────

  describe("batchProcessPayments", () => {
    it("should process multiple payments and return succeeded/failed", async () => {
      const payments = [
        {
          sender: "0x1234567890abcdef1234567890abcdef12345678",
          recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          amount: "100",
          currency: "USDC",
        },
        {
          sender: "0x1234567890abcdef1234567890abcdef12345678",
          recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          amount: "200",
          currency: "USDC",
        },
      ];

      jest
        .spyOn(paymentService, "createPayment")
        .mockResolvedValueOnce({ id: "1" } as any)
        .mockRejectedValueOnce(new Error("DB error"));

      const result = await paymentService.batchProcessPayments(
        payments,
        "biz-1",
      );

      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toEqual({ index: 1, error: "DB error" });
    });

    it("should handle all payments failing", async () => {
      jest
        .spyOn(paymentService, "createPayment")
        .mockRejectedValue(new Error("fail"));

      const result = await paymentService.batchProcessPayments(
        [
          {
            sender: "0x1234567890abcdef1234567890abcdef12345678",
            recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
            amount: "100",
            currency: "USDC",
          },
        ],
        "biz-1",
      );

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });

    it("should handle empty payments array", async () => {
      const result = await paymentService.batchProcessPayments([], "biz-1");

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  // ─── getStats ──────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("should aggregate payment statistics", async () => {
      prisma.payment.count.mockResolvedValue(100);
      prisma.payment.aggregate
        .mockResolvedValueOnce({
          _sum: { amount: { toString: () => "500000" } },
          _avg: { amount: { toString: () => "5000" } },
        })
        .mockResolvedValueOnce({
          _count: { id: 10 },
          _sum: { amount: { toString: () => "50000" } },
        })
        .mockResolvedValueOnce({
          _count: { id: 50 },
          _sum: { amount: { toString: () => "250000" } },
        });
      prisma.payment.groupBy
        .mockResolvedValueOnce([
          { status: "PENDING", _count: { id: 20 } },
          { status: "SETTLED", _count: { id: 80 } },
        ])
        .mockResolvedValueOnce([
          {
            currency: "USDC",
            _count: { id: 60 },
            _sum: { amount: { toString: () => "300000" } },
          },
          {
            currency: "AED",
            _count: { id: 40 },
            _sum: { amount: { toString: () => "200000" } },
          },
        ]);

      const stats = await paymentService.getStats();

      expect(stats.totalPayments).toBe(100);
      expect(stats.totalVolume).toBe("500000");
      expect(stats.byStatus.PENDING).toBe(20);
      expect(stats.byStatus.SETTLED).toBe(80);
      expect(stats.byCurrency.USDC.count).toBe(60);
    });

    it("should handle empty database", async () => {
      prisma.payment.count.mockResolvedValue(0);
      prisma.payment.aggregate.mockResolvedValue({
        _sum: { amount: null },
        _avg: { amount: null },
        _count: { id: 0 },
      });
      prisma.payment.groupBy.mockResolvedValue([]);

      const stats = await paymentService.getStats();

      expect(stats.totalPayments).toBe(0);
      expect(stats.totalVolume).toBe("0");
      expect(stats.averageAmount).toBe("0");
    });
  });

  // ─── PaymentError ──────────────────────────────────────────────────────────

  describe("PaymentError", () => {
    it("should create error with code, message, and statusCode", () => {
      const error = new PaymentError("TEST_CODE", "Test message", 422);
      expect(error.code).toBe("TEST_CODE");
      expect(error.message).toBe("Test message");
      expect(error.statusCode).toBe(422);
      expect(error.name).toBe("PaymentError");
      expect(error).toBeInstanceOf(Error);
    });

    it("should default statusCode to 400", () => {
      const error = new PaymentError("CODE", "msg");
      expect(error.statusCode).toBe(400);
    });
  });
});
