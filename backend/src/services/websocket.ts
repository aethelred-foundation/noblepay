import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";

const WS_JWT_SECRET: string | null = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'test') {
    return 'test-secret';
  }
  logger.error('FATAL: JWT_SECRET environment variable is required in non-test environments. WebSocket token verification will reject all connections.');
  return null;
})();

// ─── Types ──────────────────────────────────────────────────────────────────

export type WSEventType =
  | "payment_update"
  | "compliance_decision"
  | "stream_tick"
  | "alert"
  | "risk_update"
  | "treasury_event"
  | "liquidity_update"
  | "crosschain_update"
  | "system_event";

export type WSChannel =
  | "payments"
  | "compliance"
  | "treasury"
  | "streams"
  | "alerts"
  | "risk"
  | "liquidity"
  | "crosschain"
  | "system";

export interface WSMessage {
  type: WSEventType;
  channel: WSChannel;
  payload: Record<string, unknown>;
  timestamp: string;
  correlationId: string;
}

interface WSClient {
  id: string;
  ws: WebSocket;
  channels: Set<WSChannel>;
  businessId: string | null;
  connectedAt: Date;
  lastPing: Date;
  messageCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_MESSAGES_PER_WINDOW = 100;
const CLIENT_TIMEOUT_MS = 60_000;

// ─── WebSocket Server ───────────────────────────────────────────────────────

export class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WSClient> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private messageCounters: Map<string, { count: number; resetAt: number }> = new Map();

  /**
   * Attach WebSocket server to an existing HTTP server.
   */
  attach(server: HTTPServer): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws, req) => {
      const clientId = "ws-" + crypto.randomBytes(8).toString("hex");
      const ip = req.socket.remoteAddress || "unknown";

      // Authenticate via JWT: check query param ?token= or Sec-WebSocket-Protocol header
      let verifiedBusinessId: string | null = null;
      try {
        const headers = req.headers || {};
        const url = new URL(req.url || "/", `http://${headers.host || "localhost"}`);
        const token = url.searchParams.get("token") || headers["sec-websocket-protocol"] as string || null;
        if (token) {
          if (!WS_JWT_SECRET) {
            logger.warn("WebSocket JWT verification rejected: JWT_SECRET not configured", { clientId, ip });
          } else {
            const decoded = jwt.verify(token, WS_JWT_SECRET) as { businessId?: string; sub?: string };
            verifiedBusinessId = decoded.businessId || decoded.sub || null;
          }
        }
      } catch {
        // JWT verification failed — connection proceeds unauthenticated
        // Unauthenticated clients can only receive system channel broadcasts
        logger.warn("WebSocket JWT verification failed", { clientId, ip });
      }

      const client: WSClient = {
        id: clientId,
        ws,
        channels: new Set(["system"]),
        businessId: verifiedBusinessId,
        connectedAt: new Date(),
        lastPing: new Date(),
        messageCount: 0,
      };

      this.clients.set(clientId, client);

      logger.info("WebSocket client connected", { clientId, ip, businessId: verifiedBusinessId, totalClients: this.clients.size });

      // Send welcome message
      this.sendToClient(client, {
        type: "system_event",
        channel: "system",
        payload: {
          event: "connected",
          clientId,
          availableChannels: ["payments", "compliance", "treasury", "streams", "alerts", "risk", "liquidity", "crosschain", "system"],
        },
        timestamp: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
      });

      ws.on("message", (data) => {
        this.handleMessage(clientId, data.toString());
      });

      ws.on("close", () => {
        this.cleanupClient(clientId);
        logger.info("WebSocket client disconnected", { clientId, totalClients: this.clients.size });
      });

      ws.on("pong", () => {
        client.lastPing = new Date();
      });

      ws.on("error", (error) => {
        logger.error("WebSocket client error", { clientId, error: error.message });
        this.cleanupClient(clientId);
      });
    });

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);

    logger.info("WebSocket server attached", { path: "/ws" });
  }

  /**
   * Handle incoming client message.
   */
  private handleMessage(clientId: string, raw: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Rate limiting
    if (!this.checkRateLimit(clientId)) {
      this.sendToClient(client, {
        type: "system_event",
        channel: "system",
        payload: { event: "rate_limited", message: "Too many messages. Please slow down." },
        timestamp: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
      });
      return;
    }

    try {
      const message = JSON.parse(raw);
      const { action, channels, channel } = message;

      switch (action) {
        case "subscribe": {
          // Unauthenticated clients can only subscribe to the "system" channel.
          // Authenticated clients can subscribe to any valid channel.
          const requestedChannels: string[] = Array.isArray(channels)
            ? channels
            : channel
              ? [channel]
              : [];

          const rejected: string[] = [];
          for (const ch of requestedChannels) {
            if (!this.isValidChannel(ch)) continue;
            if (ch !== "system" && !client.businessId) {
              rejected.push(ch);
              continue;
            }
            client.channels.add(ch as WSChannel);
          }

          const responsePayload: Record<string, unknown> = {
            event: "subscribed",
            channels: Array.from(client.channels),
          };
          if (rejected.length > 0) {
            responsePayload.rejected = rejected;
            responsePayload.reason = "Authentication required for non-system channels";
          }
          this.sendToClient(client, {
            type: "system_event",
            channel: "system",
            payload: responsePayload,
            timestamp: new Date().toISOString(),
            correlationId: crypto.randomUUID(),
          });
          break;
        }

        case "unsubscribe":
          if (Array.isArray(channels)) {
            for (const ch of channels) {
              if (ch !== "system") client.channels.delete(ch as WSChannel);
            }
          } else if (channel && channel !== "system") {
            client.channels.delete(channel as WSChannel);
          }
          this.sendToClient(client, {
            type: "system_event",
            channel: "system",
            payload: { event: "unsubscribed", channels: Array.from(client.channels) },
            timestamp: new Date().toISOString(),
            correlationId: crypto.randomUUID(),
          });
          break;

        case "authenticate": {
          // Derive businessId from JWT token, never from self-asserted message data
          let authBusinessId: string | null = null;
          if (message.token) {
            if (!WS_JWT_SECRET) {
              this.sendToClient(client, {
                type: "system_event",
                channel: "system",
                payload: { event: "auth_failed", message: "JWT verification unavailable: server misconfigured" },
                timestamp: new Date().toISOString(),
                correlationId: crypto.randomUUID(),
              });
              break;
            }
            try {
              const decoded = jwt.verify(message.token, WS_JWT_SECRET) as { businessId?: string; sub?: string };
              authBusinessId = decoded.businessId || decoded.sub || null;
              client.businessId = authBusinessId;
            } catch {
              this.sendToClient(client, {
                type: "system_event",
                channel: "system",
                payload: { event: "auth_failed", message: "Invalid or expired token" },
                timestamp: new Date().toISOString(),
                correlationId: crypto.randomUUID(),
              });
              break;
            }
          } else {
            // No token provided — keep existing businessId from handshake
            authBusinessId = client.businessId;
          }
          this.sendToClient(client, {
            type: "system_event",
            channel: "system",
            payload: { event: "authenticated", businessId: authBusinessId },
            timestamp: new Date().toISOString(),
            correlationId: crypto.randomUUID(),
          });
          break;
        }

        case "ping":
          client.lastPing = new Date();
          this.sendToClient(client, {
            type: "system_event",
            channel: "system",
            payload: { event: "pong" },
            timestamp: new Date().toISOString(),
            correlationId: crypto.randomUUID(),
          });
          break;

        default:
          this.sendToClient(client, {
            type: "system_event",
            channel: "system",
            payload: { event: "error", message: `Unknown action: ${action}` },
            timestamp: new Date().toISOString(),
            correlationId: crypto.randomUUID(),
          });
      }
    } catch {
      this.sendToClient(client, {
        type: "system_event",
        channel: "system",
        payload: { event: "error", message: "Invalid JSON message" },
        timestamp: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
      });
    }
  }

  /**
   * Broadcast a message to all clients subscribed to a channel.
   */
  broadcast(channel: WSChannel, type: WSEventType, payload: Record<string, unknown>, targetBusinessId?: string): void {
    const message: WSMessage = {
      type,
      channel,
      payload,
      timestamp: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
    };

    let sent = 0;
    for (const client of this.clients.values()) {
      if (!client.channels.has(channel) || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      // Enforce tenant isolation: if a targetBusinessId is specified,
      // only deliver to clients whose verified businessId matches.
      if (targetBusinessId && client.businessId !== targetBusinessId) {
        continue;
      }

      // Non-system channels require authentication — never leak tenant
      // data to unauthenticated clients even if they somehow subscribed.
      if (channel !== "system" && !client.businessId) {
        continue;
      }

      this.sendToClient(client, message);
      sent++;
    }

    if (sent > 0) {
      logger.debug("WebSocket broadcast", { channel, type, recipients: sent, targetBusinessId });
    }
  }

  /**
   * Send a message to a specific client.
   */
  private sendToClient(client: WSClient, message: WSMessage): void {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
        client.messageCount++;
      }
    } catch (error) {
      logger.error("Failed to send WebSocket message", {
        clientId: client.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Check rate limit for a client.
   */
  private checkRateLimit(clientId: string): boolean {
    const now = Date.now();
    const counter = this.messageCounters.get(clientId);

    if (!counter || now > counter.resetAt) {
      this.messageCounters.set(clientId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }

    counter.count++;
    if (counter.count > MAX_MESSAGES_PER_WINDOW) {
      return false;
    }

    return true;
  }

  /**
   * Remove all state associated with a client.
   */
  private cleanupClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.channels.clear();
      client.businessId = null;
    }
    this.clients.delete(clientId);
    this.messageCounters.delete(clientId);
  }

  /**
   * Heartbeat: ping clients and remove stale connections.
   */
  private heartbeat(): void {
    const now = Date.now();

    for (const [id, client] of this.clients) {
      if (now - client.lastPing.getTime() > CLIENT_TIMEOUT_MS) {
        logger.info("WebSocket client timed out", { clientId: id });
        client.ws.terminate();
        this.cleanupClient(id);
        continue;
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }

  /**
   * Validate channel name.
   */
  private isValidChannel(channel: string): boolean {
    const valid: WSChannel[] = ["payments", "compliance", "treasury", "streams", "alerts", "risk", "liquidity", "crosschain", "system"];
    return valid.includes(channel as WSChannel);
  }

  /**
   * Get connection statistics.
   */
  getStats(): {
    totalConnections: number;
    channelSubscriptions: Record<string, number>;
    avgMessageRate: number;
  } {
    const channelSubscriptions: Record<string, number> = {};

    for (const client of this.clients.values()) {
      for (const ch of client.channels) {
        channelSubscriptions[ch] = (channelSubscriptions[ch] || 0) + 1;
      }
    }

    const totalMessages = Array.from(this.clients.values()).reduce(
      (sum, c) => sum + c.messageCount,
      0,
    );

    return {
      totalConnections: this.clients.size,
      channelSubscriptions,
      avgMessageRate: this.clients.size > 0 ? totalMessages / this.clients.size : 0,
    };
  }

  /**
   * Graceful shutdown.
   */
  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const client of this.clients.values()) {
      client.channels.clear();
      client.businessId = null;
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.messageCounters.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    logger.info("WebSocket server closed");
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const wsService = new WebSocketService();
