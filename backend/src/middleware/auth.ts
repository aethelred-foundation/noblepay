import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { PrismaClient, BusinessTier } from "@prisma/client";
import { logger } from "../lib/logger";
import { prisma } from "../lib/db";
import { getCurrentBusinessRegistryAuthorization } from "../lib/business-registry-authorization";

function jwtSecret(): string {
  const configured = process.env.JWT_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "test")
    return "noblepay-test-secret-not-for-production";
  throw new Error("JWT_SECRET is not configured");
}

export const SESSION_COOKIE_NAME = "noblepay_session";
export const CSRF_COOKIE_NAME = "noblepay_csrf";
export const SESSION_TTL_SECONDS = 15 * 60;
export const SESSION_ISSUER = "noblepay-api";
export const SESSION_AUDIENCE = "noblepay-web";

const VALID_TIERS = new Set<string>(["STANDARD", "PREMIUM", "ENTERPRISE"]);
const VALID_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "TREASURY_MANAGER",
  "COMPLIANCE_OFFICER",
  "ANALYST",
  "OPERATOR",
  "VIEWER",
]);

const TIER_RATE_LIMITS: Record<BusinessTier, number> = {
  STANDARD: 300,
  PREMIUM: 1000,
  ENTERPRISE: 5000,
};

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_SCOPE = "api";

export interface RateLimitConsumption {
  count: number;
  resetAt: Date;
}

export interface TierRateLimitStore {
  consume(input: {
    businessId: string;
    scope: string;
    windowStart: Date;
    expiresAt: Date;
  }): Promise<RateLimitConsumption>;
}

export interface PublicRateLimitStore {
  consume(input: {
    keyHash: string;
    scope: string;
    windowStart: Date;
    expiresAt: Date;
  }): Promise<RateLimitConsumption>;
}

/** PostgreSQL-backed fixed-window counter shared by every API process. */
export class PrismaTierRateLimitStore implements TierRateLimitStore {
  constructor(private readonly database: PrismaClient = prisma) {}

  async consume(input: {
    businessId: string;
    scope: string;
    windowStart: Date;
    expiresAt: Date;
  }): Promise<RateLimitConsumption> {
    return this.database.$transaction(async (transaction) => {
      // Bound storage growth without a process-local janitor. The expiry index
      // keeps this tenant-scoped cleanup inexpensive.
      await transaction.rateLimitWindow.deleteMany({
        where: {
          businessId: input.businessId,
          scope: input.scope,
          expiresAt: { lt: input.windowStart },
        },
      });

      const window = await transaction.rateLimitWindow.upsert({
        where: {
          businessId_scope_windowStart: {
            businessId: input.businessId,
            scope: input.scope,
            windowStart: input.windowStart,
          },
        },
        create: {
          businessId: input.businessId,
          scope: input.scope,
          windowStart: input.windowStart,
          expiresAt: input.expiresAt,
          count: 1,
        },
        update: { count: { increment: 1 } },
        select: { count: true, expiresAt: true },
      });

      return { count: window.count, resetAt: window.expiresAt };
    });
  }
}

export class PrismaPublicRateLimitStore implements PublicRateLimitStore {
  constructor(private readonly database: PrismaClient = prisma) {}

  async consume(input: {
    keyHash: string;
    scope: string;
    windowStart: Date;
    expiresAt: Date;
  }): Promise<RateLimitConsumption> {
    return this.database.$transaction(async (transaction) => {
      await transaction.publicRateLimitWindow.deleteMany({
        where: {
          expiresAt: { lt: input.windowStart },
        },
      });
      const window = await transaction.publicRateLimitWindow.upsert({
        where: {
          keyHash_scope_windowStart: {
            keyHash: input.keyHash,
            scope: input.scope,
            windowStart: input.windowStart,
          },
        },
        create: { ...input, count: 1 },
        update: { count: { increment: 1 } },
        select: { count: true, expiresAt: true },
      });
      return { count: window.count, resetAt: window.expiresAt };
    });
  }
}

export interface AuthenticatedRequest extends Request {
  businessId?: string;
  businessTier?: BusinessTier;
  apiKeyId?: string;
  jwtPayload?: JWTPayload;
  signerId?: string;
  authType?: "bearer" | "cookie";
  rateLimitScopes?: Set<string>;
}

export interface JWTPayload {
  sub: string;
  businessId: string;
  tier: BusinessTier;
  role: string;
  iat: number;
  exp: number;
}

export function parseCookieHeader(
  header: string | undefined,
): Record<string, string> {
  if (!header) return {};

  const cookies: Record<string, string> = {};
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Malformed cookie values are ignored instead of reaching auth logic.
    }
  }
  return cookies;
}

export function verifySessionToken(token: string): JWTPayload {
  const decoded = jwt.verify(token, jwtSecret(), {
    algorithms: ["HS256"],
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  }) as Partial<JWTPayload>;

  if (
    typeof decoded.sub !== "string" ||
    typeof decoded.businessId !== "string" ||
    typeof decoded.tier !== "string" ||
    !VALID_TIERS.has(decoded.tier) ||
    typeof decoded.role !== "string" ||
    !VALID_ROLES.has(decoded.role)
  ) {
    throw new Error("Invalid session claims");
  }

  return decoded as JWTPayload;
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes)
  );
}

function validateCookieCSRF(
  req: Request,
  cookies: Record<string, string>,
): boolean {
  const cookieToken = cookies[CSRF_COOKIE_NAME];
  const headerValue = req.headers["x-csrf-token"];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return Boolean(
    cookieToken &&
    typeof headerToken === "string" &&
    safeTokenEqual(cookieToken, headerToken),
  );
}

/**
 * Authenticate a short-lived wallet session or an API key. Browser sessions
 * may use the HttpOnly session cookie; unsafe cookie-authenticated requests
 * additionally require the double-submit CSRF token.
 */
export async function authenticateAPIKey(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // The app-level authenticated limiter may already have authenticated the
    // request before a route's defense-in-depth auth middleware runs.
    if (req.businessId && req.businessTier && req.signerId && req.jwtPayload) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    const cookies = parseCookieHeader(req.headers.cookie);
    let token: string | undefined;
    let authType: "bearer" | "cookie";

    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
      authType = "bearer";
    } else {
      token = cookies[SESSION_COOKIE_NAME];
      authType = "cookie";
    }

    if (!token) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication required",
      });
      return;
    }

    if (
      authType === "cookie" &&
      isUnsafeMethod(req.method) &&
      !validateCookieCSRF(req, cookies)
    ) {
      res.status(403).json({
        error: "CSRF_VALIDATION_FAILED",
        message: "A valid X-CSRF-Token header is required",
      });
      return;
    }

    const looksLikeJWT = token.split(".").length === 3;
    if (looksLikeJWT || authType === "cookie") {
      let decoded: JWTPayload;
      try {
        decoded = verifySessionToken(token);
      } catch {
        res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Invalid or expired session",
        });
        return;
      }
      const business = await prisma.business.findUnique({
        where: { id: decoded.businessId },
        select: { id: true, address: true },
      });
      if (
        !business ||
        business.address.toLowerCase() !== decoded.sub.toLowerCase()
      ) {
        res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Session is not bound to the registered business wallet",
        });
        return;
      }
      const current = await getCurrentBusinessRegistryAuthorization(
        business.address,
      );
      if (!current.active) {
        res.status(403).json({
          error: "BUSINESS_INACTIVE",
          message: `Business is not currently authorized (${current.status.toLowerCase()})`,
        });
        return;
      }

      // Chain state is authoritative for revocable privilege and tier. A
      // SUPER_ADMIN JWT is downgraded immediately after ADMIN_ROLE removal,
      // and stale tier claims never influence request authorization/limits.
      decoded.tier = current.tier;
      decoded.role = current.isAdmin
        ? "SUPER_ADMIN"
        : decoded.role === "SUPER_ADMIN"
          ? "ADMIN"
          : decoded.role;
      req.businessId = decoded.businessId;
      req.businessTier = current.tier;
      req.jwtPayload = decoded;
      req.signerId = decoded.sub;
      req.authType = authType;
      next();
      return;
    }

    const keyHash = crypto.createHash("sha256").update(token).digest("hex");
    const apiKey = await prisma.aPIKey.findUnique({
      where: { keyHash },
      include: { business: true },
    });

    if (!apiKey) {
      res
        .status(401)
        .json({ error: "UNAUTHORIZED", message: "Invalid API key" });
      return;
    }

    if (apiKey.status !== "ACTIVE") {
      res.status(403).json({
        error: "FORBIDDEN",
        message: `API key is ${apiKey.status.toLowerCase()}`,
      });
      return;
    }

    const current = await getCurrentBusinessRegistryAuthorization(
      apiKey.business.address,
    );
    if (!current.active) {
      res.status(403).json({
        error: "BUSINESS_INACTIVE",
        message: `Business is not currently authorized (${current.status.toLowerCase()})`,
      });
      return;
    }

    prisma.aPIKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsed: new Date() },
      })
      .catch((error: Error) => {
        logger.error("Failed to update API key last used", {
          error: error.message,
        });
      });

    req.businessId = apiKey.businessId;
    req.businessTier = current.tier;
    req.apiKeyId = apiKey.id;
    req.signerId = `apikey:${apiKey.id}`;
    req.authType = "bearer";
    // API keys represent the owning business administrator, never a platform
    // super-admin. Cross-tenant administration therefore remains fail-closed.
    req.jwtPayload = {
      sub: req.signerId,
      businessId: apiKey.businessId,
      tier: current.tier,
      role: "ADMIN",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    };

    next();
  } catch (error) {
    logger.error("Authentication service error", {
      error: (error as Error).message,
    });
    res.status(503).json({
      error: "AUTHENTICATION_UNAVAILABLE",
      message: "Authentication service unavailable",
    });
  }
}

export function createTierRateLimit(
  options: {
    store?: TierRateLimitStore;
    now?: () => number;
    scope?: string;
    limitOverride?: number;
  } = {},
) {
  const store = options.store || new PrismaTierRateLimitStore();
  const now = options.now || Date.now;
  const scope = options.scope || RATE_LIMIT_SCOPE;

  return async function durableTierRateLimit(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const businessId = req.businessId;
    const tier = req.businessTier;

    if (!businessId || !tier) {
      next();
      return;
    }

    if (req.rateLimitScopes?.has(scope)) {
      next();
      return;
    }

    const limit = options.limitOverride || TIER_RATE_LIMITS[tier];
    const nowMs = now();
    const windowStartMs =
      Math.floor(nowMs / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    const windowStart = new Date(windowStartMs);
    const expiresAt = new Date(windowStartMs + RATE_LIMIT_WINDOW_MS);

    try {
      const consumption = await store.consume({
        businessId,
        scope,
        windowStart,
        expiresAt,
      });
      const resetAtMs = consumption.resetAt.getTime();

      res.setHeader("X-RateLimit-Limit", limit);
      res.setHeader(
        "X-RateLimit-Remaining",
        Math.max(0, limit - consumption.count),
      );
      res.setHeader("X-RateLimit-Reset", Math.ceil(resetAtMs / 1000));

      if (consumption.count > limit) {
        res.setHeader(
          "Retry-After",
          Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
        );
        res.status(429).json({
          error: "RATE_LIMITED",
          message: `Rate limit exceeded for ${tier} tier (${limit} req/min)`,
          retryAfter: Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000)),
        });
        return;
      }

      if (!req.rateLimitScopes) req.rateLimitScopes = new Set<string>();
      req.rateLimitScopes.add(scope);
      next();
    } catch (error) {
      logger.error("Rate limit store unavailable", {
        businessId,
        error: (error as Error).message,
      });
      res.status(503).json({
        error: "RATE_LIMIT_UNAVAILABLE",
        message: "Request throttling service unavailable",
      });
    }
  };
}

export const tierRateLimit = createTierRateLimit();

export function createPublicRateLimit(options: {
  scope: string;
  limit: number;
  key: (req: Request) => string;
  store?: PublicRateLimitStore;
  now?: () => number;
}) {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("Public rate limit must be a positive integer");
  }
  const store = options.store || new PrismaPublicRateLimitStore();
  const now = options.now || Date.now;

  return async function durablePublicRateLimit(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const rawKey = options.key(req).trim().toLowerCase();
    const keyHash = crypto
      .createHash("sha256")
      .update(rawKey || "unknown")
      .digest("hex");
    const nowMs = now();
    const windowStartMs =
      Math.floor(nowMs / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
    try {
      const consumption = await store.consume({
        keyHash,
        scope: options.scope,
        windowStart: new Date(windowStartMs),
        expiresAt: new Date(windowStartMs + RATE_LIMIT_WINDOW_MS),
      });
      const resetAtMs = consumption.resetAt.getTime();
      res.setHeader("X-RateLimit-Limit", options.limit);
      res.setHeader(
        "X-RateLimit-Remaining",
        Math.max(0, options.limit - consumption.count),
      );
      res.setHeader("X-RateLimit-Reset", Math.ceil(resetAtMs / 1000));
      if (consumption.count > options.limit) {
        const retryAfter = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
        res.setHeader("Retry-After", retryAfter);
        res.status(429).json({
          error: "RATE_LIMITED",
          message: "Too many authentication requests. Please retry later.",
          retryAfter,
        });
        return;
      }
      next();
    } catch (error) {
      logger.error("Public rate limit store unavailable", {
        scope: options.scope,
        error: (error as Error).message,
      });
      res.status(503).json({
        error: "RATE_LIMIT_UNAVAILABLE",
        message: "Request throttling service unavailable",
      });
    }
  };
}

export function generateJWT(
  businessId: string,
  tier: BusinessTier,
  role = "VIEWER",
  userId?: string,
): string {
  const payload: Omit<JWTPayload, "iat" | "exp"> = {
    sub: userId || `user:${businessId}:${crypto.randomUUID()}`,
    businessId,
    tier,
    role,
  };

  return jwt.sign(payload, jwtSecret(), {
    algorithm: "HS256",
    expiresIn: SESSION_TTL_SECONDS,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  });
}

export function generateAPIKey(): { rawKey: string; keyHash: string } {
  const rawKey = `npk_${crypto.randomBytes(32).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  return { rawKey, keyHash };
}

/** Kept as a compatibility no-op; durable windows need no process janitor. */
export function stopRateLimitJanitor(): void {
  // Expired records are removed transactionally by PrismaTierRateLimitStore.
}
