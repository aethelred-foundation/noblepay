const mockPrisma = {
  business: { findFirst: jest.fn(), findUnique: jest.fn() },
  walletChallenge: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
};
const mockGetAddress = jest.fn((value: string) => value);
const mockSignatureValid = jest.fn();
const mockBuildMessage = jest.fn(
  (_input: unknown) => "NoblePay wallet challenge\nDomain: noblepay.test",
);
const mockBuildRegistrationCommitment = jest.fn(
  (_input: unknown) => `0x${"c".repeat(64)}`,
);
const mockIsBound = jest.fn((_message: string) => true);
const mockCurrentAuthorization = jest.fn();
let meAuthenticated = true;
let jwtRole: string | undefined = "ADMIN";

jest.mock("../../lib/db", () => ({ prisma: mockPrisma }));
jest.mock("ethers", () => ({
  getAddress: (value: string) => mockGetAddress(value),
}));
jest.mock("../../lib/wallet-challenge", () => ({
  buildRegistrationCommitment: (input: unknown) =>
    mockBuildRegistrationCommitment(input),
  buildWalletChallengeMessage: (input: unknown) => mockBuildMessage(input),
  isWalletChallengeBound: (message: string) => mockIsBound(message),
  resolveWalletRelyingParty: jest.fn(),
}));
jest.mock("../../lib/business-registry-authorization", () => ({
  getCurrentBusinessRegistryAuthorization: (address: string) =>
    mockCurrentAuthorization(address),
}));
jest.mock("../../lib/wallet-signature-authorization", () => ({
  isCurrentWalletMessageSignatureValid: (
    address: string,
    message: string,
    signature: string,
  ) => mockSignatureValid(address, message, signature),
}));
jest.mock("../../middleware/auth", () => ({
  SESSION_COOKIE_NAME: "noblepay_session",
  CSRF_COOKIE_NAME: "noblepay_csrf",
  SESSION_TTL_SECONDS: 900,
  createPublicRateLimit:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  generateJWT: jest.fn(() => "signed-session-token"),
  authenticateAPIKey: (req: any, _res: unknown, next: () => void) => {
    if (meAuthenticated) {
      req.businessId = "11111111-1111-4111-8111-111111111111";
      req.jwtPayload = { role: jwtRole };
    }
    next();
  },
}));

import express from "express";
import request from "supertest";
import { generateJWT } from "../../middleware/auth";
import router from "../../routes/auth";

const app = express();
app.use(express.json());
app.use("/v1/auth", router);

const ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"a".repeat(64)}`;
const SIGNATURE = `0x${"b".repeat(130)}`;
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const future = () => new Date(Date.now() + 60_000);
const REGISTRATION_PROFILE = {
  licenseNumber: "DMCC123456",
  businessName: "Acme Treasury",
  jurisdiction: "UAE",
  businessType: "LLC",
  complianceOfficer: OTHER_ADDRESS,
  contactEmail: "ops@acme.test",
};

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    id: CHALLENGE_ID,
    address: ADDRESS,
    nonce: "nonce",
    message: "NoblePay wallet challenge\nDomain: noblepay.test",
    expiresAt: future(),
    purpose: "AUTHENTICATION",
    transactionHash: null,
    usedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as any;
}

function business(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    address: ADDRESS,
    businessName: "Verified Business",
    kycStatus: "VERIFIED",
    tier: "STANDARD",
    contactEmail: "ops@example.com",
    ...overrides,
  } as any;
}

describe("wallet authentication routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    meAuthenticated = true;
    jwtRole = "ADMIN";
    mockGetAddress.mockImplementation((value) => value);
    mockIsBound.mockReturnValue(true);
    mockSignatureValid.mockResolvedValue(true);
    mockCurrentAuthorization.mockResolvedValue({
      active: true,
      status: "VERIFIED",
      tier: "STANDARD",
      isAdmin: false,
    });
    mockPrisma.walletChallenge.updateMany.mockResolvedValue({ count: 1 });
  });

  it("validates challenge request shape and purpose coupling", async () => {
    const invalidAddress = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: "bad" });
    const missingRegistrationTx = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS, purpose: "registration" });
    const authenticationWithTx = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS, purpose: "authentication", txHash: TX_HASH });
    const authenticationWithProfile = await request(app)
      .post("/v1/auth/challenge")
      .send({
        address: ADDRESS,
        purpose: "authentication",
        registration: REGISTRATION_PROFILE,
      });
    expect(invalidAddress.status).toBe(400);
    expect(missingRegistrationTx.status).toBe(400);
    expect(authenticationWithTx.status).toBe(400);
    expect(authenticationWithProfile.status).toBe(400);
    expect(mockPrisma.walletChallenge.create).not.toHaveBeenCalled();
  });

  it("does not disclose a challenge for an unregistered authentication wallet", async () => {
    mockPrisma.business.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("BUSINESS_NOT_REGISTERED");
  });

  it("blocks challenge creation for a suspended business", async () => {
    mockPrisma.business.findFirst.mockResolvedValue(
      business({ kycStatus: "SUSPENDED" }),
    );
    mockCurrentAuthorization.mockResolvedValue({
      active: false,
      status: "SUSPENDED",
      tier: "STANDARD",
      isAdmin: false,
    });
    const response = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("BUSINESS_INACTIVE");
  });

  it("creates a bounded authentication challenge for a registered business", async () => {
    mockPrisma.business.findFirst.mockResolvedValue(business());
    mockPrisma.walletChallenge.create.mockImplementation(
      async ({ data }: any) => ({
        id: data.id,
        message: data.message,
        purpose: data.purpose,
        transactionHash: data.transactionHash,
        expiresAt: data.expiresAt,
      }),
    );
    const response = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS });
    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      purpose: "authentication",
      txHash: null,
    });
    expect(mockPrisma.walletChallenge.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        address: ADDRESS,
        purpose: "AUTHENTICATION",
        transactionHash: null,
      }),
      select: {
        id: true,
        message: true,
        purpose: true,
        transactionHash: true,
        expiresAt: true,
      },
    });
  });

  it("creates registration challenges without requiring a pre-existing business", async () => {
    mockPrisma.walletChallenge.create.mockImplementation(
      async ({ data }: any) => ({
        id: data.id,
        message: data.message,
        purpose: data.purpose,
        transactionHash: data.transactionHash,
        expiresAt: data.expiresAt,
      }),
    );
    const response = await request(app)
      .post("/v1/auth/challenge")
      .send({
        address: ADDRESS,
        purpose: "registration",
        txHash: TX_HASH.toUpperCase().replace("0X", "0x"),
        registration: {
          ...REGISTRATION_PROFILE,
          businessName: " Acme Treasury ",
          businessType: " LLC ",
          contactEmail: " OPS@ACME.TEST ",
        },
      });
    expect(response.status).toBe(201);
    expect(response.body.data.registrationCommitment).toBe(
      `0x${"c".repeat(64)}`,
    );
    expect(mockPrisma.business.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.walletChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purpose: "REGISTRATION",
          transactionHash: TX_HASH,
        }),
      }),
    );
    expect(mockBuildRegistrationCommitment).toHaveBeenCalledWith({
      address: ADDRESS,
      txHash: TX_HASH.toUpperCase().replace("0X", "0x"),
      ...REGISTRATION_PROFILE,
    });
    expect(mockBuildMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        registrationCommitment: `0x${"c".repeat(64)}`,
      }),
    );
  });

  it("fails challenge creation safely on canonicalization or persistence errors", async () => {
    mockGetAddress.mockImplementation(() => {
      throw new Error("bad checksum");
    });
    const canonicalization = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS });
    expect(canonicalization.status).toBe(503);
    expect(canonicalization.body.error).toBe("AUTHENTICATION_UNAVAILABLE");

    mockGetAddress.mockImplementation((value) => value);
    mockPrisma.business.findFirst.mockRejectedValue(
      new Error("database password"),
    );
    const persistence = await request(app)
      .post("/v1/auth/challenge")
      .send({ address: ADDRESS });
    expect(persistence.status).toBe(503);
    expect(JSON.stringify(persistence.body)).not.toContain("password");
  });

  it("validates verification request shape", async () => {
    const response = await request(app)
      .post("/v1/auth/verify")
      .send({ address: ADDRESS });
    expect(response.status).toBe(400);
    expect(mockPrisma.walletChallenge.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["used", challenge({ usedAt: new Date() })],
    ["expired", challenge({ expiresAt: new Date(Date.now() - 1) })],
    ["wrong address", challenge({ address: OTHER_ADDRESS })],
  ])("rejects a %s challenge", async (_name, record) => {
    mockPrisma.walletChallenge.findUnique.mockResolvedValue(record);
    const response = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("INVALID_CHALLENGE");
    expect(mockSignatureValid).not.toHaveBeenCalled();
  });

  it("rejects challenge messages not bound to the relying party", async () => {
    mockPrisma.walletChallenge.findUnique.mockResolvedValue(challenge());
    mockIsBound.mockReturnValue(false);
    const response = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("INVALID_CHALLENGE");
  });

  it("routes registration challenges only through business registration", async () => {
    mockPrisma.walletChallenge.findUnique.mockResolvedValue(
      challenge({ purpose: "REGISTRATION" }),
    );
    const response = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("WRONG_CHALLENGE_PURPOSE");
  });

  it("rejects invalid EOA or EIP-1271 wallet signatures", async () => {
    mockPrisma.walletChallenge.findUnique.mockResolvedValue(challenge());
    mockSignatureValid.mockResolvedValue(false);
    const malformed = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(malformed.status).toBe(401);
    expect(malformed.body.error).toBe("INVALID_SIGNATURE");

    const mismatch = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(mismatch.status).toBe(401);
    expect(mismatch.body.error).toBe("INVALID_SIGNATURE");
  });

  it.each([
    ["missing", null, "FORBIDDEN"],
    ["suspended", business({ kycStatus: "SUSPENDED" }), "BUSINESS_INACTIVE"],
  ])(
    "blocks a %s business after signature recovery",
    async (_name, record, error) => {
      mockPrisma.walletChallenge.findUnique.mockResolvedValue(challenge());
      mockPrisma.business.findFirst.mockResolvedValue(record);
      if (record) {
        mockCurrentAuthorization.mockResolvedValue({
          active: false,
          status: "SUSPENDED",
          tier: "STANDARD",
          isAdmin: false,
        });
      }
      const response = await request(app).post("/v1/auth/verify").send({
        address: ADDRESS,
        challengeId: CHALLENGE_ID,
        signature: SIGNATURE,
      });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe(error);
    },
  );

  it("prevents challenge replay when atomic consumption loses the race", async () => {
    mockPrisma.walletChallenge.findUnique.mockResolvedValue(challenge());
    mockPrisma.business.findFirst.mockResolvedValue(business());
    mockPrisma.walletChallenge.updateMany.mockResolvedValue({ count: 0 });
    const response = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("CHALLENGE_ALREADY_USED");
    expect(generateJWT).not.toHaveBeenCalled();
  });

  it.each([
    [false, "ADMIN"],
    [true, "SUPER_ADMIN"],
  ])(
    "issues a secure session with on-chain admin=%s",
    async (isAdmin, expectedRole) => {
      mockPrisma.walletChallenge.findUnique.mockResolvedValue(challenge());
      mockPrisma.business.findFirst.mockResolvedValue(business());
      mockCurrentAuthorization.mockResolvedValue({
        active: true,
        status: "VERIFIED",
        tier: "STANDARD",
        isAdmin,
      });
      const response = await request(app).post("/v1/auth/verify").send({
        address: ADDRESS,
        challengeId: CHALLENGE_ID,
        signature: SIGNATURE,
      });
      expect(response.status).toBe(200);
      expect(response.headers["set-cookie"]).toEqual(
        expect.arrayContaining([
          expect.stringContaining("noblepay_session=signed-session-token"),
          expect.stringContaining("noblepay_csrf="),
        ]),
      );
      expect(response.body.data.business.role).toBe(expectedRole);
      expect(generateJWT).toHaveBeenCalledWith(
        business().id,
        "STANDARD",
        expectedRole,
        ADDRESS,
      );
    },
  );

  it("fails verification closed if on-chain administrator status cannot be established", async () => {
    mockPrisma.walletChallenge.findUnique.mockResolvedValue(challenge());
    mockPrisma.business.findFirst.mockResolvedValue(business());
    mockCurrentAuthorization.mockRejectedValue(new Error("RPC unavailable"));
    const response = await request(app).post("/v1/auth/verify").send({
      address: ADDRESS,
      challengeId: CHALLENGE_ID,
      signature: SIGNATURE,
    });
    expect(response.status).toBe(503);
    expect(response.body.error).toBe("AUTHENTICATION_UNAVAILABLE");
    expect(generateJWT).not.toHaveBeenCalled();
  });

  it("loads the authenticated business and signed role without caching", async () => {
    mockPrisma.business.findUnique.mockResolvedValue(business());
    const response = await request(app).get("/v1/auth/me");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      id: business().id,
      role: "ADMIN",
    });
  });

  it("uses the conservative ADMIN role fallback when an old session lacks a role claim", async () => {
    jwtRole = undefined;
    mockPrisma.business.findUnique.mockResolvedValue(business());
    const response = await request(app).get("/v1/auth/me");
    expect(response.status).toBe(200);
    expect(response.body.data.role).toBe("ADMIN");
  });

  it("rejects a session whose business was deleted and handles lookup outages", async () => {
    mockPrisma.business.findUnique
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("database down"));
    const deleted = await request(app).get("/v1/auth/me");
    const outage = await request(app).get("/v1/auth/me");
    expect(deleted.status).toBe(401);
    expect(outage.status).toBe(503);
  });

  it("clears both session cookies on logout", async () => {
    const response = await request(app).post("/v1/auth/logout");
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("noblepay_session="),
        expect.stringContaining("noblepay_csrf="),
      ]),
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
