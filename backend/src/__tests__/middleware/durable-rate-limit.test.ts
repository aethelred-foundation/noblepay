import jwt from "jsonwebtoken";
import {
  createPublicRateLimit,
  createTierRateLimit,
  generateJWT,
  PrismaPublicRateLimitStore,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  TierRateLimitStore,
  verifySessionToken,
} from "../../middleware/auth";

function response() {
  const value: any = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  value.status.mockReturnValue(value);
  return value;
}

describe("durable rate limits", () => {
  it("uses the shared store and rejects the first request above the limit", async () => {
    const store: TierRateLimitStore = {
      consume: jest
        .fn()
        .mockResolvedValueOnce({ count: 1, resetAt: new Date(60_000) })
        .mockResolvedValueOnce({ count: 2, resetAt: new Date(60_000) }),
    };
    const middleware = createTierRateLimit({
      store,
      now: () => 1,
      limitOverride: 1,
    });
    const next = jest.fn();
    await middleware(
      { businessId: "biz", businessTier: "STARTER" } as any,
      response(),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    const res = response();
    await middleware(
      { businessId: "biz", businessTier: "STARTER" } as any,
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("fails closed when durable storage is unavailable", async () => {
    const middleware = createTierRateLimit({
      store: { consume: jest.fn().mockRejectedValue(new Error("db down")) },
    });
    const res = response();
    const next = jest.fn();
    await middleware(
      { businessId: "biz", businessTier: "STARTER" } as any,
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it("globally removes expired public keys before consuming a new key", async () => {
    const transaction: any = {
      publicRateLimitWindow: {
        deleteMany: jest.fn().mockResolvedValue({ count: 10 }),
        upsert: jest
          .fn()
          .mockResolvedValue({ count: 1, expiresAt: new Date(60_000) }),
      },
    };
    const database: any = {
      $transaction: jest.fn(async (callback: (value: any) => unknown) =>
        callback(transaction),
      ),
    };
    const store = new PrismaPublicRateLimitStore(database);
    await store.consume({
      keyHash: "unique-attacker-key",
      scope: "wallet-challenge",
      windowStart: new Date(0),
      expiresAt: new Date(60_000),
    });
    expect(transaction.publicRateLimitWindow.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date(0) } },
    });
  });

  it("never stores or exposes the raw public rate-limit key", async () => {
    const store = {
      consume: jest
        .fn()
        .mockResolvedValue({ count: 1, resetAt: new Date(60_000) }),
    };
    const middleware = createPublicRateLimit({
      scope: "challenge",
      limit: 2,
      key: () => "SensitiveWalletAddress",
      store,
      now: () => 1,
    });
    await middleware({} as any, response(), jest.fn());
    const consumed = store.consume.mock.calls[0][0];
    expect(consumed.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(consumed)).not.toContain("SensitiveWalletAddress");
  });
});

describe("session token binding", () => {
  const priorSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = "s".repeat(32);
  });
  afterAll(() => {
    if (priorSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = priorSecret;
  });

  it("signs and verifies only the NoblePay issuer and audience", () => {
    const token = generateJWT("biz-1", "STANDARD", "ADMIN", "wallet:1");
    expect(verifySessionToken(token)).toMatchObject({
      businessId: "biz-1",
      sub: "wallet:1",
    });
    const foreign = jwt.sign(
      {
        sub: "wallet:1",
        businessId: "biz-1",
        tier: "STANDARD",
        role: "ADMIN",
      },
      process.env.JWT_SECRET!,
      {
        algorithm: "HS256",
        expiresIn: 60,
        issuer: SESSION_ISSUER,
        audience: "another-service",
      },
    );
    expect(() => verifySessionToken(foreign)).toThrow();
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.iss).toBe(SESSION_ISSUER);
    expect(decoded.aud).toBe(SESSION_AUDIENCE);
  });
});
