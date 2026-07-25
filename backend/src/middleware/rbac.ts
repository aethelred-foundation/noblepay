import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";
import { hasCurrentBusinessRegistryAdminRole } from "../lib/business-registry-authorization";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Role =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "TREASURY_MANAGER"
  | "COMPLIANCE_OFFICER"
  | "ANALYST"
  | "OPERATOR"
  | "VIEWER";

export type Permission =
  | "payments:read"
  | "payments:create"
  | "payments:cancel"
  | "payments:refund"
  | "compliance:read"
  | "compliance:manage"
  | "compliance:override"
  | "businesses:read"
  | "businesses:manage"
  | "treasury:read"
  | "treasury:propose"
  | "treasury:approve"
  | "treasury:execute"
  | "liquidity:read"
  | "liquidity:manage"
  | "streams:read"
  | "streams:create"
  | "streams:manage"
  | "fx:read"
  | "fx:trade"
  | "fx:manage"
  | "invoices:read"
  | "invoices:create"
  | "invoices:finance"
  | "invoices:manage"
  | "crosschain:read"
  | "crosschain:initiate"
  | "crosschain:manage"
  | "reports:read"
  | "reports:generate"
  | "reports:submit"
  | "ai:read"
  | "ai:manage"
  | "ai:override"
  | "audit:read"
  | "audit:export"
  | "settings:read"
  | "settings:manage"
  | "admin:all";

// ─── Role Hierarchy ─────────────────────────────────────────────────────────

const ROLE_HIERARCHY: Record<Role, Role[]> = {
  SUPER_ADMIN: [
    "ADMIN",
    "TREASURY_MANAGER",
    "COMPLIANCE_OFFICER",
    "ANALYST",
    "OPERATOR",
    "VIEWER",
  ],
  ADMIN: [
    "TREASURY_MANAGER",
    "COMPLIANCE_OFFICER",
    "ANALYST",
    "OPERATOR",
    "VIEWER",
  ],
  TREASURY_MANAGER: ["ANALYST", "VIEWER"],
  COMPLIANCE_OFFICER: ["ANALYST", "VIEWER"],
  ANALYST: ["VIEWER"],
  OPERATOR: ["VIEWER"],
  VIEWER: [],
};

// ─── Permission Matrix ──────────────────────────────────────────────────────

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  SUPER_ADMIN: ["admin:all"],
  ADMIN: [
    "payments:read",
    "payments:create",
    "payments:cancel",
    "payments:refund",
    "compliance:read",
    "compliance:manage",
    "compliance:override",
    "businesses:read",
    "businesses:manage",
    "treasury:read",
    "treasury:propose",
    "treasury:approve",
    "treasury:execute",
    "liquidity:read",
    "liquidity:manage",
    "streams:read",
    "streams:create",
    "streams:manage",
    "fx:read",
    "fx:trade",
    "fx:manage",
    "invoices:read",
    "invoices:create",
    "invoices:finance",
    "invoices:manage",
    "crosschain:read",
    "crosschain:initiate",
    "crosschain:manage",
    "reports:read",
    "reports:generate",
    "reports:submit",
    "ai:read",
    "ai:manage",
    "ai:override",
    "audit:read",
    "audit:export",
    "settings:read",
    "settings:manage",
  ],
  TREASURY_MANAGER: [
    "payments:read",
    "payments:create",
    "treasury:read",
    "treasury:propose",
    "treasury:approve",
    "treasury:execute",
    "liquidity:read",
    "liquidity:manage",
    "streams:read",
    "streams:create",
    "streams:manage",
    "fx:read",
    "fx:trade",
    "fx:manage",
    "invoices:read",
    "invoices:create",
    "invoices:finance",
    "reports:read",
    "reports:generate",
    "audit:read",
    "settings:read",
  ],
  COMPLIANCE_OFFICER: [
    "payments:read",
    "payments:refund",
    "compliance:read",
    "compliance:manage",
    "compliance:override",
    "businesses:read",
    "businesses:manage",
    "reports:read",
    "reports:generate",
    "reports:submit",
    "ai:read",
    "ai:manage",
    "ai:override",
    "audit:read",
    "audit:export",
    "settings:read",
  ],
  ANALYST: [
    "payments:read",
    "compliance:read",
    "businesses:read",
    "treasury:read",
    "liquidity:read",
    "streams:read",
    "fx:read",
    "invoices:read",
    "crosschain:read",
    "reports:read",
    "reports:generate",
    "ai:read",
    "audit:read",
  ],
  OPERATOR: [
    "payments:read",
    "payments:create",
    "streams:read",
    "streams:create",
    "crosschain:read",
    "crosschain:initiate",
    "invoices:read",
    "invoices:create",
    "fx:read",
    "liquidity:read",
  ],
  VIEWER: [
    "payments:read",
    "compliance:read",
    "businesses:read",
    "treasury:read",
    "liquidity:read",
    "streams:read",
    "fx:read",
    "invoices:read",
    "crosschain:read",
    "ai:read",
  ],
};

// ─── Helper Functions ───────────────────────────────────────────────────────

/**
 * Get all effective permissions for a role including inherited permissions.
 */
export function getEffectivePermissions(role: Role): Set<Permission> {
  const permissions = new Set<Permission>(ROLE_PERMISSIONS[role] || []);

  // If super admin, grant everything
  if (permissions.has("admin:all")) {
    const allPermissions = new Set<Permission>();
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) {
        allPermissions.add(p);
      }
    }
    return allPermissions;
  }

  // Add inherited role permissions
  const inherited = ROLE_HIERARCHY[role] || [];
  for (const inheritedRole of inherited) {
    const inheritedPerms = ROLE_PERMISSIONS[inheritedRole] || [];
    for (const p of inheritedPerms) {
      permissions.add(p);
    }
  }

  return permissions;
}

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  const effective = getEffectivePermissions(role);
  return effective.has(permission) || effective.has("admin:all");
}

// ─── Middleware ──────────────────────────────────────────────────────────────

export interface RBACRequest extends Request {
  userRole?: Role;
  userId?: string;
  businessId?: string;
  permissions?: Set<Permission>;
  jwtPayload?: { sub: string; businessId: string; tier: string; role?: Role };
}

/**
 * Middleware to require specific permissions.
 */
export function requirePermission(...required: Permission[]) {
  return (req: RBACRequest, res: Response, next: NextFunction): void => {
    const role = req.userRole || "VIEWER";
    const effective = getEffectivePermissions(role);

    const missing = required.filter(
      (p) => !effective.has(p) && !effective.has("admin:all"),
    );

    if (missing.length > 0) {
      logger.warn("RBAC: Permission denied", {
        userId: req.userId,
        role,
        required,
        missing,
        path: req.path,
        method: req.method,
      });

      res.status(403).json({
        error: "FORBIDDEN",
        message: `Insufficient permissions. Required: ${missing.join(", ")}`,
        requiredPermissions: missing,
      });
      return;
    }

    req.permissions = effective;
    next();
  };
}

/**
 * Middleware to require a minimum role level.
 */
export function requireRole(...roles: Role[]) {
  return (req: RBACRequest, res: Response, next: NextFunction): void => {
    const userRole = req.userRole || "VIEWER";
    // Authorization follows the explicitly declared graph. Object-key order is
    // not an authorization primitive and must never create privilege edges.
    const effectiveRoles = new Set<Role>([
      userRole,
      ...(ROLE_HIERARCHY[userRole] || []),
    ]);
    const hasAccess = roles.some((required) => effectiveRoles.has(required));

    if (!hasAccess) {
      logger.warn("RBAC: Role denied", {
        userId: req.userId,
        userRole,
        requiredRoles: roles,
        path: req.path,
      });

      res.status(403).json({
        error: "FORBIDDEN",
        message: `Insufficient role. Required: ${roles.join(" or ")}`,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to extract role and userId from JWT token (not headers).
 * Headers are untrusted and must not be used for authorization decisions.
 */
export function extractRole(
  req: RBACRequest,
  _res: Response,
  next: NextFunction,
): void {
  const validRoles: Role[] = [
    "SUPER_ADMIN",
    "ADMIN",
    "TREASURY_MANAGER",
    "COMPLIANCE_OFFICER",
    "ANALYST",
    "OPERATOR",
    "VIEWER",
  ];

  // Derive role from authenticated JWT payload, never from headers
  const jwtPayload = req.jwtPayload;
  if (
    jwtPayload &&
    jwtPayload.role &&
    validRoles.includes(jwtPayload.role as Role)
  ) {
    req.userRole = jwtPayload.role as Role;
  } else {
    req.userRole = "VIEWER";
  }

  // Derive userId from JWT subject, never from headers
  req.userId = jwtPayload?.sub || req.businessId || "anonymous";
  next();
}

/**
 * Check that the requesting business owns the target resource.
 * Returns true if the caller owns the resource. Only a platform SUPER_ADMIN
 * may cross tenant boundaries; business ADMIN is intentionally tenant-local.
 */
export function requireOwnership(
  req: RBACRequest,
  resourceBusinessId: string,
): boolean {
  const callerBusinessId = req.businessId;
  if (!callerBusinessId) return false;
  if (callerBusinessId === resourceBusinessId) return true;
  const role = req.userRole || "VIEWER";
  return role === "SUPER_ADMIN";
}

/** Require and revalidate the on-chain platform administrator role. */
export async function requireCurrentPlatformAdmin(
  req: RBACRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.userRole !== "SUPER_ADMIN") {
    res.status(403).json({
      error: "FORBIDDEN",
      message:
        "A current BusinessRegistry administrator wallet session is required",
    });
    return;
  }
  await checkCurrentPlatformAdmin(req, res, next);
}

/** Recheck only sessions that are using cross-tenant SUPER_ADMIN authority. */
export async function revalidatePlatformAdmin(
  req: RBACRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.userRole !== "SUPER_ADMIN") {
    next();
    return;
  }
  await checkCurrentPlatformAdmin(req, res, next);
}

async function checkCurrentPlatformAdmin(
  req: RBACRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const signer = req.jwtPayload?.sub;
    if (!signer || !(await hasCurrentBusinessRegistryAdminRole(signer))) {
      res.status(403).json({
        error: "PLATFORM_ADMIN_ROLE_REQUIRED",
        message: "The wallet no longer holds BusinessRegistry ADMIN_ROLE",
      });
      return;
    }
    next();
  } catch (error) {
    logger.error("Platform administrator role check unavailable", {
      error: (error as Error).message,
    });
    res.status(503).json({
      error: "AUTHORIZATION_UNAVAILABLE",
      message: "Unable to verify the current platform administrator role",
    });
  }
}
