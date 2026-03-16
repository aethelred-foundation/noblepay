import { resetAllMocks } from "../setup";
import jwt from "jsonwebtoken";

const TEST_JWT_SECRET = "test-secret";

// Mock ws module
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

function createTestJWT(businessId: string): string {
  return jwt.sign({ sub: businessId, businessId, tier: "ENTERPRISE" }, TEST_JWT_SECRET, { expiresIn: "1h" });
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

      expect(mockWSSInstance.on).toHaveBeenCalledWith("connection", expect.any(Function));
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

    it("should handle client disconnect", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // Find the close handler
      const closeHandler = ws.on.mock.calls.find((c: any) => c[0] === "close")![1];
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

      const errorHandler = ws.on.mock.calls.find((c: any) => c[0] === "error")![1];
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

      const pongHandler = ws.on.mock.calls.find((c: any) => c[0] === "pong")![1];
      pongHandler();

      // No error means the pong handler works
      expect(service.getStats().totalConnections).toBe(1);

      service.close();
    });
  });

  // ─── handleMessage ────────────────────────────────────────────────────────

  describe("handleMessage (via message event)", () => {
    function setupServiceWithClient(authenticated = false) {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();

      if (authenticated) {
        const token = createTestJWT("biz-test");
        connectionHandler(ws, {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {},
          url: `/ws?token=${token}`,
        });
      } else {
        connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });
      }

      const messageHandler = ws.on.mock.calls.find((c: any) => c[0] === "message")![1];

      // Reset send mock after welcome message
      ws.send.mockClear();

      return { service, ws, messageHandler };
    }

    it("should handle subscribe action with single channel (authenticated)", () => {
      const { service, ws, messageHandler } = setupServiceWithClient(true);

      messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("subscribed");
      expect(response.payload.channels).toContain("payments");

      service.close();
    });

    it("should handle subscribe action with multiple channels (authenticated)", () => {
      const { service, ws, messageHandler } = setupServiceWithClient(true);

      messageHandler(
        JSON.stringify({ action: "subscribe", channels: ["payments", "compliance", "treasury"] }),
      );

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).toContain("payments");
      expect(response.payload.channels).toContain("compliance");
      expect(response.payload.channels).toContain("treasury");

      service.close();
    });

    it("should ignore invalid channel names", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      messageHandler(JSON.stringify({ action: "subscribe", channel: "invalid_channel" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).not.toContain("invalid_channel");

      service.close();
    });

    it("should handle unsubscribe action", () => {
      const { service, ws, messageHandler } = setupServiceWithClient(true);

      // Subscribe first (authenticated client can subscribe)
      messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));
      ws.send.mockClear();

      // Unsubscribe
      messageHandler(JSON.stringify({ action: "unsubscribe", channel: "payments" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("unsubscribed");
      expect(response.payload.channels).not.toContain("payments");

      service.close();
    });

    it("should not allow unsubscribe from system channel", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      messageHandler(JSON.stringify({ action: "unsubscribe", channel: "system" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.channels).toContain("system");

      service.close();
    });

    it("should handle unsubscribe with multiple channels", () => {
      const { service, ws, messageHandler } = setupServiceWithClient(true);

      messageHandler(JSON.stringify({ action: "subscribe", channels: ["payments", "compliance"] }));
      ws.send.mockClear();

      messageHandler(JSON.stringify({ action: "unsubscribe", channels: ["payments", "system"] }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      // payments removed, system kept
      expect(response.payload.channels).not.toContain("payments");
      expect(response.payload.channels).toContain("system");

      service.close();
    });

    it("should handle authenticate action with valid JWT token", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      const token = createTestJWT("biz-1");
      messageHandler(JSON.stringify({ action: "authenticate", token }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("authenticated");
      expect(response.payload.businessId).toBe("biz-1");

      service.close();
    });

    it("should handle ping action", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      messageHandler(JSON.stringify({ action: "ping" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("pong");

      service.close();
    });

    it("should handle authenticate action without token (keeps handshake businessId)", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      messageHandler(JSON.stringify({ action: "authenticate" }));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("authenticated");
      // businessId is null because no token was provided during handshake or authenticate
      expect(response.payload.businessId).toBeNull();

      service.close();
    });

    it("should handle unknown action", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      messageHandler(JSON.stringify({ action: "unknown_action" }));

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

      const messageHandler = ws.on.mock.calls.find((c: any) => c[0] === "message")![1];
      ws.send.mockClear();

      // Simulate disconnect by triggering close handler
      const closeHandler = ws.on.mock.calls.find((c: any) => c[0] === "close")![1];
      closeHandler();

      // Now send a message after disconnect -- client not found, should return early
      messageHandler(JSON.stringify({ action: "ping" }));

      // No send should happen since client is gone
      expect(ws.send).not.toHaveBeenCalled();

      service.close();
    });

    it("should handle invalid JSON", () => {
      const { service, ws, messageHandler } = setupServiceWithClient();

      messageHandler("not valid json {{{");

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.payload.event).toBe("error");
      expect(response.payload.message).toBe("Invalid JSON message");

      service.close();
    });
  });

  // ─── broadcast ────────────────────────────────────────────────────────────

  describe("broadcast", () => {
    it("should broadcast to clients subscribed to a channel", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      // Connect two clients — ws1 is authenticated, ws2 is not
      const ws1 = createMockWS();
      const ws2 = createMockWS();

      const token = createTestJWT("biz-1");
      connectionHandler(ws1, {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
        url: `/ws?token=${token}`,
      });
      connectionHandler(ws2, { socket: { remoteAddress: "127.0.0.2" } });

      // Subscribe ws1 to payments (authenticated — should succeed)
      const msg1Handler = ws1.on.mock.calls.find((c: any) => c[0] === "message")![1];
      msg1Handler(JSON.stringify({ action: "subscribe", channel: "payments" }));

      ws1.send.mockClear();
      ws2.send.mockClear();

      service.broadcast("payments", "payment_update", { paymentId: "pay-1" });

      // ws1 should receive (subscribed to payments, authenticated)
      expect(ws1.send).toHaveBeenCalledTimes(1);
      const broadcastMsg = JSON.parse(ws1.send.mock.calls[0][0]);
      expect(broadcastMsg.channel).toBe("payments");
      expect(broadcastMsg.payload.paymentId).toBe("pay-1");

      // ws2 should NOT receive (not subscribed to payments)
      expect(ws2.send).not.toHaveBeenCalled();

      service.close();
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

      const messageHandler = ws.on.mock.calls.find((c: any) => c[0] === "message")![1];
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

    it("should return correct channel subscriptions", () => {
      const service = new WebSocketService();
      service.attach(createMockHTTPServer());

      const connectionHandler = mockWSSInstance.on.mock.calls.find(
        (c: any) => c[0] === "connection",
      )![1];

      const ws = createMockWS();
      const token = createTestJWT("biz-stats");
      connectionHandler(ws, {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {},
        url: `/ws?token=${token}`,
      });

      const messageHandler = ws.on.mock.calls.find((c: any) => c[0] === "message")![1];
      messageHandler(JSON.stringify({ action: "subscribe", channels: ["payments", "compliance"] }));

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
      ws.send.mockImplementation(() => { throw new Error("Send failed"); });
      connectionHandler(ws, { socket: { remoteAddress: "127.0.0.1" } });

      // The welcome message send threw, but should not crash
      // broadcast should also be handled gracefully
      const messageHandler = ws.on.mock.calls.find((c: any) => c[0] === "message")![1];

      // Re-mock send to throw for the subscribe response too
      ws.send.mockImplementation(() => { throw new Error("Send failed again"); });
      messageHandler(JSON.stringify({ action: "subscribe", channel: "payments" }));

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
