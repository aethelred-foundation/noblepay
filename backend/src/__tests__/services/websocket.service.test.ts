import { resetAllMocks } from "../setup";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "noblepay-test-secret-not-for-production";

// Mock ws module
const mockWSSInstance = {
  on: jest.fn(),
  close: jest.fn(),
};
const mockBusinessFindUnique = jest.fn();
const mockCurrentAuthorization = jest.fn();

jest.mock("../../lib/db", () => ({
  prisma: {
    business: {
      findUnique: (...args: unknown[]) => mockBusinessFindUnique(...args),
    },
  },
}));
jest.mock("../../lib/business-registry-authorization", () => ({
  getCurrentBusinessRegistryAuthorization: (address: string) =>
    mockCurrentAuthorization(address),
}));

jest.mock("ws", () => ({
  WebSocketServer: jest.fn(() => mockWSSInstance),
  WebSocket: {
    OPEN: 1,
    CLOSED: 3,
  },
}));

import { WebSocketService } from "../../services/websocket";
import { WebSocket, WebSocketServer } from "ws";

function createTestJWT(businessId: string): string {
  return jwt.sign(
    {
      sub: "0x1234567890abcdef1234567890abcdef12345678",
      businessId,
      tier: "ENTERPRISE",
      role: "ADMIN",
    },
    TEST_JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "1h",
      issuer: "noblepay-api",
      audience: "noblepay-web",
    },
  );
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

beforeEach(() => {
  resetAllMocks();
  mockBusinessFindUnique.mockResolvedValue({
    id: "biz-test",
    address: "0x1234567890abcdef1234567890abcdef12345678",
  });
  mockBusinessFindUnique.mockImplementation(async ({ where }: any) => ({
    id: where.id,
    address: "0x1234567890abcdef1234567890abcdef12345678",
  }));
  mockCurrentAuthorization.mockResolvedValue({
    active: true,
    status: "VERIFIED",
    wallet: "0x1234567890abcdef1234567890abcdef12345678",
  });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("WebSocketService", () => {
  // ─── attach ───────────────────────────────────────────────────────────────

  describe("attach", () => {
    it("should create a WebSocketServer and listen for connections", () => {
      const service = new WebSocketService();
      const server = createMockHTTPServer();

      service.attach(server);

      expect(WebSocketServer).toHaveBeenCalledWith(
        expect.objectContaining({
          server,
          path: "/ws",
          maxPayload: 16 * 1024,
          perMessageDeflate: false,
        }),
      );
      expect(mockWSSInstance.on).toHaveBeenCalledWith(
        "connection",
        expect.any(Function),
      );
      service.close();
    });
  });

  // ─── connection handling ──────────────────────────────────────────────────

  describe("connection handling", () => {
    it("should register a new client on connection", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      const req = { socket: { remoteAddress: "127.0.0.1" } };

      connectionHandler(ws, req);

      // Client should be registered
      const stats = service.getStats();
      expect(stats.totalConnections).toBe(1);
      expect(stats.channelSubscriptions.system).toBe(1);

      // Welcome message sent
      expect(ws.send).toHaveBeenCalledTimes(1);
      const welcomeMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(welcomeMsg.type).toBe("system_event");
      expect(welcomeMsg.payload.event).toBe("connected");

      service.close();
    });

    it("should handle connection with no remoteAddress", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      const req = { socket: { remoteAddress: undefined } };

      connectionHandler(ws, req);

      // Client should still be registered
      const stats = service.getStats();
      expect(stats.totalConnections).toBe(1);

      service.close();
    });

    it.each([
      ["SUSPENDED", false],
      ["REVOKED", false],
      ["RPC_FAILURE", true],
    ])(
      "does not authenticate a wallet session when current-chain authorization is %s",
      async (status, rpcFailure) => {
        if (rpcFailure)
          mockCurrentAuthorization.mockRejectedValue(
            new Error("RPC unavailable"),
          );
        else
          mockCurrentAuthorization.mockResolvedValue({
            active: false,
            status,
            wallet: "0x1234567890abcdef1234567890abcdef12345678",
          });
        const service = new WebSocketService();
        service.attach(createMockHTTPServer());
        const connectionHandler = mockWSSInstance.on.mock.calls.find(
          (call: any) => call[0] === "connection",
        )![1];
        const ws = createMockWS();
        await connectionHandler(ws, {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            cookie: `noblepay_session=${encodeURIComponent(createTestJWT("biz-1"))}`,
          },
        });
        const messageHandler = ws.on.mock.calls.find(
          (call: any) => call[0] === "message",
        )![1];
        ws.send.mockClear();
        await messageHandler(
          JSON.stringify({ action: "subscribe", channel: "payments" }),
        );
        const response = JSON.parse(ws.send.mock.calls[0][0]);
        expect(response.payload.rejected).toContain("payments");
        expect(response.payload.channels).toEqual(["system"]);
        service.close();
      },
    );

    it("should handle client disconnect", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // Find the close handler
      const closeHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "close",
      )![1];
      closeHandler();

      expect(service.getStats().totalConnections).toBe(0);

      service.close();
    });

    it("should handle client error", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      const errorHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "error",
      )![1];
      errorHandler(new Error("Connection reset"));

      expect(service.getStats().totalConnections).toBe(0);

      service.close();
    });

    it("should update lastPing on pong", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      const pongHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "pong",
      )![1];
      pongHandler();

      // No error means the pong handler works
      expect(service.getStats().totalConnections).toBe(1);

      service.close();
    });
  });

  // ─── handleMessage ────────────────────────────────────────────────────────

  describe("handleMessage (via message event)", () => {
    async function setupServiceWithClient(authenticated = false) {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();

      if (authenticated) {
        const token = createTestJWT("biz-test");
        await connectionHandler(ws, {
          socket: { remoteAddress: "127.0.0.1" },
          headers: { cookie: `noblepay_session=${encodeURIComponent(token)}` },
          url: "/ws",
        });
      } else {
        await connectionHandler(ws, {
          socket: { remoteAddress: "127.0.0.1" },
        });
      }

      const messageHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "message",
      )![1];

      // Reset send mock after welcome message
      ws.send.mockClear();

      return { service, ws, messageHandler };
    }

    it("should handle subscribe action with single channel (authenticated)", async () => {
      const { service, ws, messageHandler } =
        await setupServiceWithClient(true);

      await messageHandler(
        JSON.stringify({ action: "subscribe", channel: "payments" }),
      );

      expect(ws.send).toHaveBeenCalledTimes(1);
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("subscribed");
      expect(response.payload.channels).toContain("payments");

      service.close();
    });

    it("should handle subscribe action with multiple channels (authenticated)", async () => {
      const { service, ws, messageHandler } =
        await setupServiceWithClient(true);

      await messageHandler(
        JSON.stringify({
          action: "subscribe",
          channels: ["payments", "compliance", "treasury"],
        }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).toContain("payments");
      expect(response.payload.channels).toContain("compliance");
      expect(response.payload.channels).toContain("treasury");

      service.close();
    });

    it("should ignore invalid channel names", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      await messageHandler(
        JSON.stringify({ action: "subscribe", channel: "invalid_channel" }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).not.toContain("invalid_channel");

      service.close();
    });

    it("should handle unsubscribe action", async () => {
      const { service, ws, messageHandler } =
        await setupServiceWithClient(true);

      // Subscribe first (authenticated client can subscribe)
      await messageHandler(
        JSON.stringify({ action: "subscribe", channel: "payments" }),
      );
      ws.send.mockClear();

      // Unsubscribe
      await messageHandler(
        JSON.stringify({ action: "unsubscribe", channel: "payments" }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("unsubscribed");
      expect(response.payload.channels).not.toContain("payments");

      service.close();
    });

    it("should not allow unsubscribe from system channel", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      await messageHandler(
        JSON.stringify({ action: "unsubscribe", channel: "system" }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).toContain("system");

      service.close();
    });

    it("should handle unsubscribe with multiple channels", async () => {
      const { service, ws, messageHandler } =
        await setupServiceWithClient(true);

      await messageHandler(
        JSON.stringify({
          action: "subscribe",
          channels: ["payments", "compliance"],
        }),
      );
      ws.send.mockClear();

      await messageHandler(
        JSON.stringify({
          action: "unsubscribe",
          channels: ["payments", "system"],
        }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      // payments removed, system kept
      expect(response.payload.channels).not.toContain("payments");
      expect(response.payload.channels).toContain("system");

      service.close();
    });

    it("should handle authenticate action with valid JWT token", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      const token = createTestJWT("biz-1");
      await messageHandler(JSON.stringify({ action: "authenticate", token }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("authenticated");
      expect(response.payload.businessId).toBe("biz-1");

      service.close();
    });

    it("should handle ping action", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      await messageHandler(JSON.stringify({ action: "ping" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("pong");

      service.close();
    });

    it("should reject authenticate action without a token", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      await messageHandler(JSON.stringify({ action: "authenticate" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("auth_failed");

      service.close();
    });

    it("should handle unknown action", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      await messageHandler(JSON.stringify({ action: "unknown_action" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("error");
      expect(response.payload.message).toContain("Unknown action");

      service.close();
    });

    it("should handle message after client disconnect (client not found)", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      const messageHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "message",
      )![1];
      ws.send.mockClear();

      // Simulate disconnect by triggering close handler
      const closeHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "close",
      )![1];
      closeHandler();

      // Now send a message after disconnect -- client not found, should return early
      messageHandler(JSON.stringify({ action: "ping" }));

      // No send should happen since client is gone
      expect(ws.send).not.toHaveBeenCalled();

      service.close();
    });

    it("should handle invalid JSON", async () => {
      const { service, ws, messageHandler } = await setupServiceWithClient();

      await messageHandler("not valid json {{{");

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("error");
      expect(response.payload.message).toBe("Invalid JSON message");

      service.close();
    });
  });

  // ─── broadcast ────────────────────────────────────────────────────────────

  describe("broadcast", () => {
    it("should broadcast to clients subscribed to a channel", async () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      // Connect two clients — ws1 is authenticated, ws2 is not
      const ws1 = createMockWS();
      const ws2 = createMockWS();

      const token = createTestJWT("biz-1");
      await connectionHandler(ws1, {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { cookie: `noblepay_session=${encodeURIComponent(token)}` },
        url: "/ws",
      });
      await connectionHandler(ws2, {
        socket: { remoteAddress: "127.0.0.2" },
      });

      // Subscribe ws1 to payments (authenticated — should succeed)
      const msg1Handler = ws1.on.mock.calls.find(
        (c: any) => c[0] === "message",
      )![1];
      await msg1Handler(
        JSON.stringify({ action: "subscribe", channel: "payments" }),
      );

      ws1.send.mockClear();
      ws2.send.mockClear();

      await service.broadcast(
        "payments",
        "payment_update",
        { paymentId: "pay-1" },
        "biz-1",
      );

      // ws1 should receive (subscribed to payments, authenticated)
      expect(ws1.send).toHaveBeenCalledTimes(1);
      const broadcastMsg = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(broadcastMsg.channel).toBe("payments");
      expect(broadcastMsg.payload.paymentId).toBe("pay-1");

      // ws2 should NOT receive (not subscribed to payments)
      expect(ws2.send).not.toHaveBeenCalled();

      service.close();
    });

    it.each([
      ["SUSPENDED", false],
      ["REVOKED", false],
      ["RPC_FAILURE", true],
    ])(
      "closes an already-authenticated tenant before delivery when chain authorization becomes %s",
      async (status, rpcFailure) => {
        const service = new WebSocketService();
        service.attach(createMockHTTPServer());
        const connectionHandler = mockWSSInstance.on.mock.calls.find(
          (call: any) => call[0] === "connection",
        )![1];
        const ws = createMockWS();
        await connectionHandler(ws, {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            cookie: `noblepay_session=${encodeURIComponent(createTestJWT("biz-1"))}`,
          },
        });
        const messageHandler = ws.on.mock.calls.find(
          (call: any) => call[0] === "message",
        )![1];
        await messageHandler(
          JSON.stringify({ action: "subscribe", channel: "payments" }),
        );
        ws.send.mockClear();
        if (rpcFailure)
          mockCurrentAuthorization.mockRejectedValue(
            new Error("RPC unavailable"),
          );
        else
          mockCurrentAuthorization.mockResolvedValue({
            active: false,
            status,
            wallet: "0x1234567890abcdef1234567890abcdef12345678",
          });

        await service.broadcast(
          "payments",
          "payment_update",
          { paymentId: "pay-revoked" },
          "biz-1",
        );

        expect(ws.send).not.toHaveBeenCalled();
        expect(ws.close).toHaveBeenCalledWith(
          4003,
          "Business authorization revoked or unavailable",
        );
        expect(service.getStats().totalConnections).toBe(0);
        service.close();
      },
    );

    it("refuses a non-system broadcast when its tenant target is missing at runtime", async () => {
      const service = new WebSocketService();
      const invokeWithoutTarget = service.broadcast as unknown as (
        channel: string,
        type: string,
        payload: Record<string, unknown>,
      ) => Promise<void>;

      await expect(
        invokeWithoutTarget("payments", "payment_update", {
          paymentId: "pay-1",
        }),
      ).rejects.toThrow("targetBusinessId is required");
    });

    it("should not send to clients with closed connections", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS(WebSocket.CLOSED as number);
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // The welcome message will not be sent because readyState is CLOSED
      // but we need to manually subscribe to test broadcast
      ws.send.mockClear();

      service.broadcast("system", "system_event", { data: "test" });

      expect(ws.send).not.toHaveBeenCalled();

      service.close();
    });
  });

  // ─── rate limiting ────────────────────────────────────────────────────────

  describe("rate limiting", () => {
    it("should rate limit after exceeding max messages per window", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      const messageHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "message",
      )![1];
      ws.send.mockClear();

      // Send 101 messages to exceed the 100 limit
      for (let i = 0; i < 101; i++) {
        messageHandler(JSON.stringify({ action: "ping" }));
      }

      // The last message should be a rate_limited response
      const lastCall = ws.send.mock.calls[ws.send.mock.calls.length - 1];
      const lastMsg = JSON.parse(lastCall[0]);
      expect(lastMsg.payload.event).toBe("rate_limited");

      service.close();
    });
  });

  // ─── getStats ─────────────────────────────────────────────────────────────

  describe("getStats", () => {
    it("should return empty stats with no clients", () => {
      const service = new WebSocketService();
      const stats = service.getStats();

      expect(stats.totalConnections).toBe(0);
      expect(stats.channelSubscriptions).toEqual({});
      expect(stats.avgMessageRate).toBe(0);
    });

    it("should return correct channel subscriptions", async () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      const token = createTestJWT("biz-stats");
      await connectionHandler(ws, {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { cookie: `noblepay_session=${encodeURIComponent(token)}` },
        url: "/ws",
      });

      const messageHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "message",
      )![1];
      await messageHandler(
        JSON.stringify({
          action: "subscribe",
          channels: ["payments", "compliance"],
        }),
      );

      const stats = service.getStats();
      expect(stats.totalConnections).toBe(1);
      expect(stats.channelSubscriptions.system).toBe(1);
      expect(stats.channelSubscriptions.payments).toBe(1);
      expect(stats.channelSubscriptions.compliance).toBe(1);

      service.close();
    });
  });

  // ─── sendToClient error handling ─────────────────────────────────────────

  describe("sendToClient error handling", () => {
    it("should catch errors when send throws", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      ws.send.mockImplementation(() => {
        throw new Error("Send failed");
      });
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // The welcome message send threw, but should not crash
      // broadcast should also be handled gracefully
      const messageHandler = ws.on.mock.calls.find(
        (c: any) => c[0] === "message",
      )![1];

      // Re-mock send to throw for the subscribe response too
      ws.send.mockImplementation(() => {
        throw new Error("Send failed again");
      });
      messageHandler(
        JSON.stringify({ action: "subscribe", channel: "payments" }),
      );

      // Should not crash the service
      expect(service.getStats().totalConnections).toBe(1);

      service.close();
    });
  });

  // ─── heartbeat ──────────────────────────────────────────────────────────────

  describe("heartbeat", () => {
    it("should terminate timed-out clients during heartbeat", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // Advance time past the CLIENT_TIMEOUT_MS (60s)
      jest.advanceTimersByTime(61000);

      // Trigger the heartbeat interval (runs every 30s)
      jest.advanceTimersByTime(30000);

      // Client should have been terminated
      expect(ws.terminate).toHaveBeenCalled();

      service.close();
    });

    it("should ping active clients during heartbeat", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // Advance time a bit but not past timeout
      jest.advanceTimersByTime(30000);

      // The heartbeat should have pinged the active client
      expect(ws.ping).toHaveBeenCalled();

      service.close();
    });
  });

  // ─── close ────────────────────────────────────────────────────────────────

  describe("close", () => {
    it("should close all client connections and the server", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      service.close();

      expect(ws.close).toHaveBeenCalledWith(1001, "Server shutting down");
      expect(mockWSSInstance.close).toHaveBeenCalled();
      expect(service.getStats().totalConnections).toBe(0);
    });

    it("should handle close without attach", () => {
      const service = new WebSocketService();

      // Should not throw
      expect(() => service.close()).not.toThrow();
    });
  });
});
