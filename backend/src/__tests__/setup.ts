/**
 * Global test setup — mocks for PrismaClient, logger, metrics, and Express helpers.
 */

// ─── Mock Logger ─────────────────────────────────────────────────────────────

export const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

jest.mock("../../src/lib/logger", () => ({
  logger: mockLogger,
  generateCorrelationId: jest.fn().mockReturnValue("test-correlation-id"),
  createRequestLogger: jest.fn().mockReturnValue(mockLogger),
}));

// ─── Mock Metrics ────────────────────────────────────────────────────────────

export const mockCounter = { inc: jest.fn() };
export const mockHistogram = { observe: jest.fn() };
export const mockGauge = { set: jest.fn() };

jest.mock("../../src/lib/metrics", () => ({
  paymentTotal: mockCounter,
  paymentAmount: mockHistogram,
  screeningDuration: mockHistogram,
  compliancePassRate: mockGauge,
  flaggedPayments: mockGauge,
  activeBusinesses: mockGauge,
  httpRequestDuration: mockHistogram,
  httpRequestTotal: mockCounter,
  teeNodesActive: mockGauge,
  teeAttestationFailures: mockCounter,
  register: { metrics: jest.fn() },
}));

// ─── Prisma Mock Factory ─────────────────────────────────────────────────────

function createMockModel() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    upsert: jest.fn(),
  };
}

export function createMockPrisma() {
  return {
    payment: createMockModel(),
    business: createMockModel(),
    auditLog: createMockModel(),
    complianceScreening: createMockModel(),
    tEENode: createMockModel(),
    aPIKey: createMockModel(),
    travelRuleRecord: createMockModel(),
    treasuryProposal: createMockModel(),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
    $transaction: jest.fn(),
  } as any;
}

// ─── Express Request / Response Helpers ──────────────────────────────────────

export function createMockRequest(overrides: Record<string, any> = {}) {
  return {
    body: {},
    params: {},
    query: {},
    headers: {},
    path: "/test",
    method: "GET",
    businessId: "test-business-id",
    businessTier: "STANDARD",
    ...overrides,
  } as any;
}

export function createMockResponse() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    headersSent: false,
  };
  return res;
}

export function createMockNext() {
  return jest.fn();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const VALID_ETH_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
export const VALID_ETH_ADDRESS_2 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
export const VALID_BYTES32 =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

export function resetAllMocks() {
  jest.clearAllMocks();
}
