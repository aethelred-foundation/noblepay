import { Router, Response } from "express";
import crypto from "crypto";
import { getAddress } from "ethers";
import { z } from "zod";
import {
  AuthenticatedRequest,
  authenticateAPIKey,
  CSRF_COOKIE_NAME,
  createPublicRateLimit,
  generateJWT,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "../middleware/auth";
import { logger } from "../lib/logger";
import { prisma } from "../lib/db";
import {
  buildRegistrationCommitment,
  buildWalletChallengeMessage,
  isWalletChallengeBound,
} from "../lib/wallet-challenge";
import { getCurrentBusinessRegistryAuthorization } from "../lib/business-registry-authorization";
import { BusinessRegistrationProfileSchema } from "../middleware/validation";
import { isCurrentWalletMessageSignatureValid } from "../lib/wallet-signature-authorization";

export {
  buildWalletChallengeMessage,
  resolveWalletRelyingParty,
} from "../lib/wallet-challenge";

const router = Router();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const challengeLimiter = createPublicRateLimit({
  scope: "wallet-challenge",
  limit: 10,
  key: (req) =>
    typeof req.body?.address === "string" ? req.body.address : req.ip,
});
const verificationLimiter = createPublicRateLimit({
  scope: "wallet-verification",
  limit: 10,
  key: (req) =>
    typeof req.body?.address === "string" ? req.body.address : req.ip,
});

const addressSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address"),
});

const challengeSchema = addressSchema
  .extend({
    purpose: z
      .enum(["authentication", "registration"])
      .default("authentication"),
    txHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash")
      .optional(),
    registration: BusinessRegistrationProfileSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.purpose === "registration" &&
      (!value.txHash || !value.registration)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: !value.txHash ? ["txHash"] : ["registration"],
        message:
          "txHash and the complete registration profile are required for a registration challenge",
      });
    }
    if (
      value.purpose === "authentication" &&
      (value.txHash || value.registration)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.txHash ? ["txHash"] : ["registration"],
        message:
          "Registration transaction and profile fields are only valid for a registration challenge",
      });
    }
  });

const verifySchema = addressSchema.extend({
  challengeId: z.string().uuid(),
  signature: z
    .string()
    .min(4)
    .max(32_770)
    .regex(/^0x(?:[a-fA-F0-9]{2})+$/, "Invalid EVM signature"),
});

function cookieOptions(httpOnly: boolean) {
  return {
    httpOnly,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  };
}

function clearCookieOptions(httpOnly: boolean) {
  const { maxAge: _maxAge, ...options } = cookieOptions(httpOnly);
  return options;
}

function validationFailure(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "VALIDATION_ERROR",
    message: "Request validation failed",
    details: error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  });
}

router.post("/challenge", challengeLimiter, async (req, res): Promise<void> => {
  const parsed = challengeSchema.safeParse(req.body);
  if (!parsed.success) {
    validationFailure(res, parsed.error);
    return;
  }

  try {
    const address = getAddress(parsed.data.address);
    if (parsed.data.purpose === "authentication") {
      const business = await prisma.business.findFirst({
        where: { address: { equals: address, mode: "insensitive" } },
        select: { id: true },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_REGISTERED",
          message:
            "Register this wallet as a NoblePay business before signing in",
        });
        return;
      }

      const current = await getCurrentBusinessRegistryAuthorization(address);
      if (!current.active) {
        res.status(403).json({
          error: "BUSINESS_INACTIVE",
          message: `Business is not currently authorized (${current.status.toLowerCase()})`,
        });
        return;
      }
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
    const challengeId = crypto.randomUUID();
    const registrationCommitment =
      parsed.data.purpose === "registration"
        ? buildRegistrationCommitment({
            address,
            txHash: parsed.data.txHash!,
            ...parsed.data.registration!,
          })
        : undefined;
    const message = buildWalletChallengeMessage({
      address,
      purpose: parsed.data.purpose,
      nonce,
      issuedAt,
      expiresAt,
      challengeId,
      txHash: parsed.data.txHash,
      registrationCommitment,
    });

    const challenge = await prisma.walletChallenge.create({
      data: {
        id: challengeId,
        address,
        nonce,
        message,
        expiresAt,
        purpose:
          parsed.data.purpose === "registration"
            ? "REGISTRATION"
            : "AUTHENTICATION",
        transactionHash: parsed.data.txHash?.toLowerCase() || null,
      },
      select: {
        id: true,
        message: true,
        purpose: true,
        transactionHash: true,
        expiresAt: true,
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      success: true,
      data: {
        challengeId: challenge.id,
        message: challenge.message,
        purpose: challenge.purpose.toLowerCase(),
        txHash: challenge.transactionHash,
        registrationCommitment: registrationCommitment || null,
        expiresAt: challenge.expiresAt,
      },
    });
  } catch (error) {
    logger.error("Failed to create wallet challenge", {
      error: (error as Error).message,
    });
    res.status(503).json({
      error: "AUTHENTICATION_UNAVAILABLE",
      message: "Authentication service unavailable",
    });
  }
});

router.post("/verify", verificationLimiter, async (req, res): Promise<void> => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    validationFailure(res, parsed.error);
    return;
  }

  try {
    const address = getAddress(parsed.data.address);
    const challenge = await prisma.walletChallenge.findUnique({
      where: { id: parsed.data.challengeId },
    });

    if (
      !challenge ||
      challenge.usedAt ||
      challenge.expiresAt.getTime() <= Date.now() ||
      challenge.address.toLowerCase() !== address.toLowerCase() ||
      !isWalletChallengeBound(challenge.message)
    ) {
      res.status(401).json({
        error: "INVALID_CHALLENGE",
        message: "Challenge is invalid, expired, or already used",
      });
      return;
    }

    if (challenge.purpose !== "AUTHENTICATION") {
      res.status(400).json({
        error: "WRONG_CHALLENGE_PURPOSE",
        message:
          "Registration challenges must be submitted with the business registration request",
      });
      return;
    }

    if (
      !(await isCurrentWalletMessageSignatureValid(
        address,
        challenge.message,
        parsed.data.signature,
      ))
    ) {
      res.status(401).json({
        error: "INVALID_SIGNATURE",
        message: "Wallet signature is invalid",
      });
      return;
    }

    const business = await prisma.business.findFirst({
      where: { address: { equals: address, mode: "insensitive" } },
    });
    if (!business) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: "Business is not eligible to sign in",
      });
      return;
    }

    // Status, tier and platform-admin privilege come from one canonical chain
    // snapshot. RPC/reorg/registry failures abort sign-in rather than minting a
    // session from stale database state.
    const current = await getCurrentBusinessRegistryAuthorization(address);
    if (!current.active) {
      res.status(403).json({
        error: "BUSINESS_INACTIVE",
        message: `Business is not currently authorized (${current.status.toLowerCase()})`,
      });
      return;
    }
    const sessionRole = current.isAdmin ? "SUPER_ADMIN" : "ADMIN";

    const consumed = await prisma.walletChallenge.updateMany({
      where: {
        id: challenge.id,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      res.status(409).json({
        error: "CHALLENGE_ALREADY_USED",
        message: "Challenge has already been consumed",
      });
      return;
    }

    const sessionToken = generateJWT(
      business.id,
      current.tier,
      sessionRole,
      address,
    );
    const csrfToken = crypto.randomBytes(32).toString("base64url");

    res.cookie(SESSION_COOKIE_NAME, sessionToken, cookieOptions(true));
    res.cookie(CSRF_COOKIE_NAME, csrfToken, cookieOptions(false));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      data: {
        business: {
          id: business.id,
          address: business.address,
          businessName: business.businessName,
          kycStatus: current.status,
          tier: current.tier,
          role: sessionRole,
        },
        expiresIn: SESSION_TTL_SECONDS,
      },
    });
  } catch (error) {
    logger.error("Failed to verify wallet challenge", {
      error: (error as Error).message,
    });
    res.status(503).json({
      error: "AUTHENTICATION_UNAVAILABLE",
      message: "Authentication service unavailable",
    });
  }
});

router.get(
  "/me",
  authenticateAPIKey,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const business = await prisma.business.findUnique({
        where: { id: req.businessId },
        select: {
          id: true,
          address: true,
          businessName: true,
          kycStatus: true,
          tier: true,
          contactEmail: true,
        },
      });
      if (!business) {
        res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Session business no longer exists",
        });
        return;
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        data: { ...business, role: req.jwtPayload?.role || "ADMIN" },
      });
    } catch (error) {
      logger.error("Failed to load authenticated business", {
        error: (error as Error).message,
      });
      res.status(503).json({
        error: "AUTHENTICATION_UNAVAILABLE",
        message: "Authentication service unavailable",
      });
    }
  },
);

router.post("/logout", authenticateAPIKey, (_req, res): void => {
  res.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions(true));
  res.clearCookie(CSRF_COOKIE_NAME, clearCookieOptions(false));
  res.setHeader("Cache-Control", "no-store");
  res.json({ success: true, data: { loggedOut: true } });
});

export default router;
