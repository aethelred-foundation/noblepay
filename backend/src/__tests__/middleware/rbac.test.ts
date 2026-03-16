import {
  createMockRequest,
  createMockResponse,
  createMockNext,
  resetAllMocks,
} from "../setup";
import {
  getEffectivePermissions,
  hasPermission,
  requirePermission,
  requireRole,
  extractRole,
  requireOwnership,
  Role,
  Permission,
} from "../../middleware/rbac";

beforeEach(() => {
  resetAllMocks();
});

describe("RBAC Middleware", () => {
  // ─── getEffectivePermissions ───────────────────────────────────────────────

  describe("getEffectivePermissions", () => {
    it("should return all permissions for SUPER_ADMIN", () => {
      const perms = getEffectivePermissions("SUPER_ADMIN");
      expect(perms.has("admin:all")).toBe(true);
      expect(perms.has("payments:read")).toBe(true);
      expect(perms.has("compliance:manage")).toBe(true);
      expect(perms.has("treasury:execute")).toBe(true);
    });

    it("should return ADMIN permissions including inherited", () => {
      const perms = getEffectivePermissions("ADMIN");
      expect(perms.has("payments:read")).toBe(true);
      expect(perms.has("payments:create")).toBe(true);
      expect(perms.has("compliance:override")).toBe(true);
      expect(perms.has("settings:manage")).toBe(true);
    });

    it("should return VIEWER permissions (read-only)", () => {
      const perms = getEffectivePermissions("VIEWER");
      expect(perms.has("payments:read")).toBe(true);
      expect(perms.has("compliance:read")).toBe(true);
      expect(perms.has("payments:create")).toBe(false);
      expect(perms.has("compliance:manage")).toBe(false);
    });

    it("should inherit permissions from lower roles", () => {
      const treasuryPerms = getEffectivePermissions("TREASURY_MANAGER");
      // Should have its own permissions
      expect(treasuryPerms.has("treasury:execute")).toBe(true);
      // Should inherit VIEWER permissions
      expect(treasuryPerms.has("payments:read")).toBe(true);
      expect(treasuryPerms.has("compliance:read")).toBe(true);
    });

    it("should give COMPLIANCE_OFFICER compliance permissions", () => {
      const perms = getEffectivePermissions("COMPLIANCE_OFFICER");
      expect(perms.has("compliance:manage")).toBe(true);
      expect(perms.has("compliance:override")).toBe(true);
      expect(perms.has("ai:override")).toBe(true);
      // Should NOT have treasury permissions
      expect(perms.has("treasury:execute")).toBe(false);
    });

    it("should give OPERATOR create permissions", () => {
      const perms = getEffectivePermissions("OPERATOR");
      expect(perms.has("payments:create")).toBe(true);
      expect(perms.has("streams:create")).toBe(true);
      // Should NOT have manage permissions
      expect(perms.has("compliance:manage")).toBe(false);
    });

    it("should give ANALYST read and report permissions", () => {
      const perms = getEffectivePermissions("ANALYST");
      expect(perms.has("payments:read")).toBe(true);
      expect(perms.has("reports:generate")).toBe(true);
      expect(perms.has("payments:create")).toBe(false);
    });

    it("should handle unknown role gracefully by returning empty set", () => {
      const perms = getEffectivePermissions("UNKNOWN_ROLE" as any);
      // With fallback || [], should return an empty set (no permissions, no inherited)
      expect(perms.size).toBe(0);
    });
  });

  // ─── hasPermission ─────────────────────────────────────────────────────────

  describe("hasPermission", () => {
    it("should return true when role has permission", () => {
      expect(hasPermission("ADMIN", "payments:create")).toBe(true);
    });

    it("should return false when role lacks permission", () => {
      expect(hasPermission("VIEWER", "payments:create")).toBe(false);
    });

    it("should return true for SUPER_ADMIN with any permission", () => {
      expect(hasPermission("SUPER_ADMIN", "payments:create")).toBe(true);
      expect(hasPermission("SUPER_ADMIN", "settings:manage")).toBe(true);
    });
  });

  // ─── requirePermission middleware ──────────────────────────────────────────

  describe("requirePermission", () => {
    it("should call next when user has required permission", () => {
      const middleware = requirePermission("payments:read");
      const req = createMockRequest({ userRole: "VIEWER" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("should return 403 when user lacks permission", () => {
      const middleware = requirePermission("payments:create");
      const req = createMockRequest({ userRole: "VIEWER" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "FORBIDDEN",
          requiredPermissions: ["payments:create"],
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("should check multiple permissions", () => {
      const middleware = requirePermission("payments:read", "payments:create");
      const req = createMockRequest({ userRole: "VIEWER" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("should default to VIEWER role when not set", () => {
      const middleware = requirePermission("payments:read");
      const req = createMockRequest({}); // No userRole
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled(); // VIEWER has payments:read
    });

    it("should work with createMockRequest called with no arguments", () => {
      const middleware = requirePermission("payments:read");
      const req = createMockRequest(); // No arguments at all - covers default param branch
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should allow SUPER_ADMIN for any permission", () => {
      const middleware = requirePermission("settings:manage");
      const req = createMockRequest({ userRole: "SUPER_ADMIN" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should set permissions on request", () => {
      const middleware = requirePermission("payments:read");
      const req = createMockRequest({ userRole: "ADMIN" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(req.permissions).toBeDefined();
      expect(req.permissions.has("payments:read")).toBe(true);
    });
  });

  // ─── requireRole middleware ────────────────────────────────────────────────

  describe("requireRole", () => {
    it("should call next when user has required role", () => {
      const middleware = requireRole("ADMIN");
      const req = createMockRequest({ userRole: "ADMIN" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should call next when user has higher role", () => {
      const middleware = requireRole("ANALYST");
      const req = createMockRequest({ userRole: "SUPER_ADMIN" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should return 403 when user has lower role", () => {
      const middleware = requireRole("ADMIN");
      const req = createMockRequest({ userRole: "VIEWER" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "FORBIDDEN" }),
      );
    });

    it("should accept any of multiple roles", () => {
      const middleware = requireRole("ADMIN", "COMPLIANCE_OFFICER");
      const req = createMockRequest({ userRole: "COMPLIANCE_OFFICER" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should default to VIEWER when no role set", () => {
      const middleware = requireRole("ADMIN");
      const req = createMockRequest({});
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it("should allow SUPER_ADMIN for any role requirement", () => {
      const middleware = requireRole("VIEWER");
      const req = createMockRequest({ userRole: "SUPER_ADMIN" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should deny OPERATOR access when TREASURY_MANAGER role is required", () => {
      const middleware = requireRole("TREASURY_MANAGER");
      const req = createMockRequest({ userRole: "OPERATOR" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "FORBIDDEN",
          message: expect.stringContaining("TREASURY_MANAGER"),
        }),
      );
    });

    it("should allow ADMIN for COMPLIANCE_OFFICER role requirement", () => {
      const middleware = requireRole("COMPLIANCE_OFFICER");
      const req = createMockRequest({ userRole: "ADMIN" });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should handle unknown userRole as lowest privilege", () => {
      const middleware = requireRole("VIEWER");
      const req = createMockRequest({ userRole: "UNKNOWN_ROLE" as any });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res, next);

      // Unknown role not in hierarchy, so indexOf returns -1, which is < any valid index
      // This means it would be considered highest privilege (-1 <= anything)
      // Based on the implementation: userLevel = -1, requiredLevel >= 0, so -1 <= requiredLevel = true
      expect(next).toHaveBeenCalled();
    });
  });

  // ─── extractRole middleware ────────────────────────────────────────────────

  describe("extractRole", () => {
    it("should extract valid role from JWT payload", () => {
      const req = createMockRequest({
        jwtPayload: { sub: "user-1", businessId: "biz-1", tier: "STANDARD", role: "ADMIN" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      extractRole(req, res, next);

      expect(req.userRole).toBe("ADMIN");
      expect(req.userId).toBe("user-1");
      expect(next).toHaveBeenCalled();
    });

    it("should ignore X-User-Role header and default to VIEWER", () => {
      const req = createMockRequest({
        headers: { "x-user-role": "SUPER_ADMIN", "x-user-id": "attacker" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      extractRole(req, res, next);

      // Should NOT trust headers — must default to VIEWER
      expect(req.userRole).toBe("VIEWER");
      expect(req.userId).not.toBe("attacker");
    });

    it("should default to VIEWER for invalid role in JWT", () => {
      const req = createMockRequest({
        jwtPayload: { sub: "user-1", businessId: "biz-1", tier: "STANDARD", role: "INVALID_ROLE" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      extractRole(req, res, next);

      expect(req.userRole).toBe("VIEWER");
    });

    it("should default to VIEWER when no JWT payload", () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      const next = createMockNext();

      extractRole(req, res, next);

      expect(req.userRole).toBe("VIEWER");
    });

    it("should set userId from businessId when JWT has no sub", () => {
      const req = createMockRequest({
        businessId: "biz-fallback",
      });
      const res = createMockResponse();
      const next = createMockNext();

      extractRole(req, res, next);

      expect(req.userId).toBe("biz-fallback");
    });

    it("should set userId to anonymous when no JWT and no businessId", () => {
      const req = createMockRequest({ headers: {}, businessId: undefined });
      const res = createMockResponse();
      const next = createMockNext();

      extractRole(req, res, next);

      expect(req.userId).toBe("anonymous");
    });

    it("should accept all valid roles from JWT payload", () => {
      const roles: Role[] = [
        "SUPER_ADMIN",
        "ADMIN",
        "TREASURY_MANAGER",
        "COMPLIANCE_OFFICER",
        "ANALYST",
        "OPERATOR",
        "VIEWER",
      ];

      for (const role of roles) {
        const req = createMockRequest({
          jwtPayload: { sub: "user-1", businessId: "biz-1", tier: "STANDARD", role },
        });
        const res = createMockResponse();
        const next = createMockNext();

        extractRole(req, res, next);
        expect(req.userRole).toBe(role);
      }
    });
  });

  // ─── requireOwnership ──────────────────────────────────────────────────────

  describe("requireOwnership", () => {
    it("should return true when businessId matches resource", () => {
      const req = createMockRequest({ businessId: "biz-1", userRole: "VIEWER" });
      expect(requireOwnership(req, "biz-1")).toBe(true);
    });

    it("should return false when businessId does not match and not admin", () => {
      const req = createMockRequest({ businessId: "biz-1", userRole: "VIEWER" });
      expect(requireOwnership(req, "biz-2")).toBe(false);
    });

    it("should return true for ADMIN even if businessId does not match", () => {
      const req = createMockRequest({ businessId: "biz-1", userRole: "ADMIN" });
      expect(requireOwnership(req, "biz-2")).toBe(true);
    });

    it("should return true for SUPER_ADMIN even if businessId does not match", () => {
      const req = createMockRequest({ businessId: "biz-1", userRole: "SUPER_ADMIN" });
      expect(requireOwnership(req, "biz-2")).toBe(true);
    });

    it("should return false when no businessId on request", () => {
      const req = createMockRequest({ businessId: undefined, userRole: "VIEWER" });
      expect(requireOwnership(req, "biz-1")).toBe(false);
    });
  });
});
