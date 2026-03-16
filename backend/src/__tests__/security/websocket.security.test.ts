/**
 * WebSocket Security Tests
 *
 * Validates tenant isolation, authentication enforcement, connection cleanup,
 * and rate limiting in the WebSocket service.
 */
import { resetAllMocks } from "../setup";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-secret";

// ─── Mock ws module ──────────────────────────────────────────────────────────

const mockWSSInstance = {
  on: jest.fn(),
  close: jest.fn(),
};

jest.mock("ws", () => ({
  WebSocketServer: jest.fn(() => mockWSSInstance),
  WebSocket: {
    OPEN: 1,
    CLOSED: 3,
  },
}));

import { WebSocketService } from "../../services/websocket";
import { WebSocket } from "ws";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTestJWT(businessId: string): string {
  return jwt.sign({ sub: `user:${businessId}`, businessId, tier: "ENTERPRISE" }, TEST_JWT_SECRET, { expiresIn: "1h" });
}

function createMockWS(readyState: number = WebSocket.OPEN as number) {
  return {
    readyState,
    send: jest.fn(),
    ping: jest.fn(),
    close: jest.fn(),
    terminate: jest.fn(),
    on: jest.fn(),
  } as any;
}

function createMockHTTPServer() {
  return {} as any;
}

function getConnectionHandler(): Function {
  const entry = mockWSSInstance.on.mock.calls.find((c: any) => c[0] === "connection");
  if (!entry) throw new Error("No connection handler registered on WSS");
  return entry[1];
}

function getWSHandler(ws: any, event: string): Function {
  const entry = ws.on.mock.calls.find((c: any) => c[0] === event);
  if (!entry) throw new Error(`No '${event}' handler registered on ws mock`);
  return entry[1];
}

/** Connect a client to the service and return helpers. */
function connectClient(
  connectionHandler: Function,
  opts: { token?: string; ip?: string } = {},
) {
  const ws = createMockWS();
  const req: any = {
    socket: { remoteAddress: opts.ip || "127.0.0.1" },
    headers: {},
    url: opts.token ? `/ws?token=${opts.token}` : "/ws",
  };

  connectionHandler(ws, req);

  const messageHandler = getWSHandler(ws, "message");
  const closeHandler = getWSHandler(ws, "close");

  // Reset send after welcome message
  ws.send.mockClear();

  return { ws, messageHandler, closeHandler };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("WebSocket Security", () => {
  // ─── Authentication enforcement ──────────────────────────────────────────

  describe("unauthenticated client restrictions", () => {
    it("unauthenticated client can only receive system broadcasts", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws } = connectClient(handler);

      // Broadcast on system channel — unauthenticated client should receive
      service.broadcast("system", "system_event", { msg: "hello" });
      expect(ws.send).toHaveBeenCalledTimes(1);
      const systemMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(systemMsg.channel).toBe("system");

      ws.send.mockClear();

      // Broadcast on payments channel — unauthenticated client must NOT receive
      // (even if they tried to subscribe, the subscribe is rejected; but even if
      // subscription state were bypassed, the broadcast guard should block it)
      service.broadcast("payments", "payment_update", { paymentId: "p-1" });
      expect(ws.send).not.toHaveBeenCalled();

      service.close();
    });

    it("unauthenticated client cannot subscribe to tenant channels", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws, messageHandler } = connectClient(handler);

      // Attempt to subscribe to payments (a tenant channel)
      messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("subscribed");
      // payments must be rejected
      expect(response.payload.channels).not.toContain("payments");
      expect(response.payload.rejected).toContain("payments");
      expect(response.payload.reason).toMatch(/authentication required/i);
      // system should still be there
      expect(response.payload.channels).toContain("system");

      service.close();
    });

    it("unauthenticated client cannot subscribe to multiple tenant channels", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws, messageHandler } = connectClient(handler);

      messageHandler(
        JSON.stringify({ action: "subscribe", channels: ["payments", "compliance", "system"] }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      // Only system should be subscribed
      expect(response.payload.channels).toEqual(["system"]);
      expect(response.payload.rejected).toContain("payments");
      expect(response.payload.rejected).toContain("compliance");

      service.close();
    });
  });

  // ─── Tenant isolation ────────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("authenticated client for Business A cannot receive Business B events", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const tokenA = createTestJWT("business-a");
      const tokenB = createTestJWT("business-b");

      const clientA = connectClient(handler, { token: tokenA, ip: "10.0.0.1" });
      const clientB = connectClient(handler, { token: tokenB, ip: "10.0.0.2" });

      // Both subscribe to payments
      clientA.messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));
      clientB.messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));
      clientA.ws.send.mockClear();
      clientB.ws.send.mockClear();

      // Broadcast targeted to business-b only
      service.broadcast("payments", "payment_update", { paymentId: "pay-b-1" }, "business-b");

      // Client A must NOT receive business-b's payment update
      expect(clientA.ws.send).not.toHaveBeenCalled();

      // Client B should receive it
      expect(clientB.ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(clientB.ws.send.mock.calls[0][0]);
      expect(msg.payload.paymentId).toBe("pay-b-1");

      service.close();
    });

    it("broadcast to tenant channel only reaches authenticated clients of that tenant", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const tokenA = createTestJWT("tenant-alpha");
      const tokenB = createTestJWT("tenant-beta");

      const clientA = connectClient(handler, { token: tokenA });
      const clientB = connectClient(handler, { token: tokenB });
      const clientUnauth = connectClient(handler); // no token

      // All three attempt to subscribe to "compliance"
      clientA.messageHandler(JSON.stringify({ action: "subscribe", channel: "compliance" }));
      clientB.messageHandler(JSON.stringify({ action: "subscribe", channel: "compliance" }));
      clientUnauth.messageHandler(JSON.stringify({ action: "subscribe", channel: "compliance" }));

      clientA.ws.send.mockClear();
      clientB.ws.send.mockClear();
      clientUnauth.ws.send.mockClear();

      // Broadcast targeted to tenant-alpha
      service.broadcast("compliance", "compliance_decision", { result: "pass" }, "tenant-alpha");

      // Only client A should receive
      expect(clientA.ws.send).toHaveBeenCalledTimes(1);
      expect(clientB.ws.send).not.toHaveBeenCalled();
      expect(clientUnauth.ws.send).not.toHaveBeenCalled();

      service.close();
    });

    it("untargeted broadcast on non-system channel skips unauthenticated clients", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const tokenA = createTestJWT("biz-1");
      const clientAuth = connectClient(handler, { token: tokenA });
      const clientUnauth = connectClient(handler);

      clientAuth.messageHandler(JSON.stringify({ action: "subscribe", channel: "treasury" }));
      // Unauthenticated client tries but gets rejected — even so, verify broadcast guard
      clientUnauth.messageHandler(JSON.stringify({ action: "subscribe", channel: "treasury" }));

      clientAuth.ws.send.mockClear();
      clientUnauth.ws.send.mockClear();

      // Broadcast without targetBusinessId — all authenticated subscribers get it
      service.broadcast("treasury", "treasury_event", { vault: "v-1" });

      expect(clientAuth.ws.send).toHaveBeenCalledTimes(1);
      expect(clientUnauth.ws.send).not.toHaveBeenCalled();

      service.close();
    });
  });

  // ─── Forged JWT rejection ────────────────────────────────────────────────

  describe("JWT verification", () => {
    it("forged JWT token rejected on authenticate action", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws, messageHandler } = connectClient(handler);

      // Create a token signed with the wrong secret
      const forgedToken = jwt.sign(
        { sub: "attacker", businessId: "victim-biz", tier: "INSTITUTIONAL" },
        "wrong-secret-key",
        { expiresIn: "1h" } as jwt.SignOptions,
      );

      messageHandler(JSON.stringify({ action: "authenticate", token: forgedToken }));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("auth_failed");
      expect(response.payload.message).toMatch(/invalid or expired/i);

      service.close();
    });

    it("expired JWT token rejected on authenticate action", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws, messageHandler } = connectClient(handler);

      // Create an already-expired token (expiresIn: 0 seconds ago)
      const expiredToken = jwt.sign(
        { sub: "user-1", businessId: "biz-1", tier: "STANDARD", exp: Math.floor(Date.now() / 1000) - 60 },
        TEST_JWT_SECRET,
      );

      messageHandler(JSON.stringify({ action: "authenticate", token: expiredToken }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("auth_failed");

      service.close();
    });

    it("tampered JWT payload rejected on handshake", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      // Create a valid token, then tamper with the payload
      const validToken = createTestJWT("legit-biz");
      const parts = validToken.split(".");
      // Modify the payload to claim a different businessId
      const tamperedPayload = Buffer.from(
        JSON.stringify({ sub: "attacker", businessId: "stolen-biz", tier: "INSTITUTIONAL" }),
      ).toString("base64url");
      const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

      const ws = createMockWS();
      const req: any = {
        socket: { remoteAddress: "10.0.0.99" },
        headers: {},
        url: `/ws?token=${tamperedToken}`,
      };

      handler(ws, req);

      // Welcome message is sent (connection proceeds unauthenticated after failed verify)
      expect(ws.send).toHaveBeenCalledTimes(1);
      const welcome = JSON.parse(ws.send.mock.calls[0][0]);
      expect(welcome.payload.event).toBe("connected");

      // Verify the client is NOT authenticated with the tampered businessId
      // by trying to subscribe to a tenant channel — should be rejected
      const msgHandler = getWSHandler(ws, "message");
      ws.send.mockClear();
      msgHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));

      const subResponse = JSON.parse(ws.send.mock.calls[0][0]);
      expect(subResponse.payload.rejected).toContain("payments");

      service.close();
    });
  });

  // ─── Connection cleanup ──────────────────────────────────────────────────

  describe("connection cleanup", () => {
    it("client disconnect properly cleans up all subscriptions", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const token = createTestJWT("cleanup-biz");
      const { ws, messageHandler, closeHandler } = connectClient(handler, { token });

      // Subscribe to several channels
      messageHandler(
        JSON.stringify({ action: "subscribe", channels: ["payments", "compliance", "treasury"] }),
      );

      // Verify subscriptions exist
      const statsBefore = service.getStats();
      expect(statsBefore.totalConnections).toBe(1);
      expect(statsBefore.channelSubscriptions.payments).toBe(1);
      expect(statsBefore.channelSubscriptions.compliance).toBe(1);
      expect(statsBefore.channelSubscriptions.treasury).toBe(1);

      // Disconnect
      closeHandler();

      // All state should be cleaned up
      const statsAfter = service.getStats();
      expect(statsAfter.totalConnections).toBe(0);
      expect(statsAfter.channelSubscriptions).toEqual({});

      // Broadcast should not reach the disconnected client
      ws.send.mockClear();
      service.broadcast("payments", "payment_update", { paymentId: "p-after" });
      expect(ws.send).not.toHaveBeenCalled();

      service.close();
    });

    it("error event properly cleans up client state", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const token = createTestJWT("error-biz");
      const { ws } = connectClient(handler, { token });

      expect(service.getStats().totalConnections).toBe(1);

      // Trigger error
      const errorHandler = getWSHandler(ws, "error");
      errorHandler(new Error("Connection reset by peer"));

      expect(service.getStats().totalConnections).toBe(0);
      expect(service.getStats().channelSubscriptions).toEqual({});

      service.close();
    });

    it("server close cleans up heartbeat timer and all client state", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const token = createTestJWT("shutdown-biz");
      const { ws } = connectClient(handler, { token });

      expect(service.getStats().totalConnections).toBe(1);

      service.close();

      expect(service.getStats().totalConnections).toBe(0);
      expect(ws.close).toHaveBeenCalledWith(1001, "Server shutting down");

      // Subsequent broadcast should not throw or send anything
      ws.send.mockClear();
      service.broadcast("system", "system_event", { msg: "after-close" });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("heartbeat timeout terminates client and cleans up state", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws } = connectClient(handler);

      expect(service.getStats().totalConnections).toBe(1);

      // Advance time past CLIENT_TIMEOUT_MS (60s) + trigger heartbeat (30s interval)
      jest.advanceTimersByTime(91_000);

      expect(ws.terminate).toHaveBeenCalled();
      expect(service.getStats().totalConnections).toBe(0);

      service.close();
    });
  });

  // ─── Rate limiting ───────────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("rate limiting blocks message floods", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws, messageHandler } = connectClient(handler);

      // Send 100 messages (the limit) — all should be processed
      for (let i = 0; i < 100; i++) {
        messageHandler(JSON.stringify({ action: "ping" }));
      }

      // All 100 should have gotten pong responses
      const pongCount = ws.send.mock.calls.filter((call: any) => {
        const msg = JSON.parse(call[0]);
        return msg.payload.event === "pong";
      }).length;
      expect(pongCount).toBe(100);

      ws.send.mockClear();

      // Message 101 should be rate-limited
      messageHandler(JSON.stringify({ action: "ping" }));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const rateLimitMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(rateLimitMsg.payload.event).toBe("rate_limited");

      ws.send.mockClear();

      // Subsequent messages should also be rate-limited
      messageHandler(JSON.stringify({ action: "ping" }));
      const secondLimitMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(secondLimitMsg.payload.event).toBe("rate_limited");

      service.close();
    });

    it("rate limit resets after the window expires", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      const { ws, messageHandler } = connectClient(handler);

      // Exhaust the rate limit
      for (let i = 0; i < 101; i++) {
        messageHandler(JSON.stringify({ action: "ping" }));
      }
      ws.send.mockClear();

      // Advance past the 60-second rate limit window
      jest.advanceTimersByTime(61_000);

      // Should be able to send again
      messageHandler(JSON.stringify({ action: "ping" }));
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("pong");

      service.close();
    });
  });

  // ─── Post-authentication subscribe ────────────────────────────────────────

  describe("authentication then subscribe flow", () => {
    it("client can subscribe to tenant channels after successful authenticate action", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());
      const handler = getConnectionHandler();

      // Connect without token (unauthenticated)
      const { ws, messageHandler } = connectClient(handler);

      // Attempt subscribe — should be rejected
      messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));
      let response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.rejected).toContain("payments");
      ws.send.mockClear();

      // Authenticate
      const token = createTestJWT("late-auth-biz");
      messageHandler(JSON.stringify({ action: "authenticate", token }));
      response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("authenticated");
      expect(response.payload.businessId).toBe("late-auth-biz");
      ws.send.mockClear();

      // Now subscribe should succeed
      messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));
      response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).toContain("payments");
      expect(response.payload.rejected).toBeUndefined();

      service.close();
    });
  });
});
