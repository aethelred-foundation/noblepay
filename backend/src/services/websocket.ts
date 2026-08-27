import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import { logger } from "../lib/logger";
import {
  parseCookieHeader,
  SESSION_COOKIE_NAME,
  type JWTPayload,
  verifySessionToken,
} from "../middleware/auth";
import { prisma } from "../lib/db";
import { getCurrentBusinessRegistryAuthorization } from "../lib/business-registry-authorization";

const WS_ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3008")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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

export type WSTenantChannel = Exclude<WSChannel, "system">;

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
  signerAddress: string | null;
  sessionExpiresAt: number | null;
  connectedAt: Date;
  lastPing: Date;
  messageCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_MESSAGES_PER_WINDOW = 100;
const CLIENT_TIMEOUT_MS = 60_000;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const SESSION_EXPIRED_CLOSE_CODE = 4001;
const AUTHORIZATION_REVOKED_CLOSE_CODE = 4003;

// ─── WebSocket Server ───────────────────────────────────────────────────────

export class WebSocketService {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WSClient> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private messageCounters: Map<string, { count: number; resetAt: number }> =
    new Map();

  /**
   * Attach WebSocket server to an existing HTTP server.
   */
  attach(server: HTTPServer): void {
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
      verifyClient(info, done) {
        const origin = info.origin;
        // Browser cookie authentication is protected against cross-site
        // WebSocket hijacking by the same explicit origin allowlist as CORS.
        if (origin && !WS_ALLOWED_ORIGINS.includes(origin)) {
          done(false, 403, "Origin not allowed");
          return;
        }
        done(true);
      },
    });

    this.wss.on("connection", async (ws, req) => {
      const clientId = "ws-" + crypto.randomBytes(8).toString("hex");
      const ip = req.socket.remoteAddress || "unknown";

      // Browser clients use the same HttpOnly wallet session cookie as HTTP.
      // Non-browser clients may use an Authorization bearer session token.
      let verifiedBusinessId: string | null = null;
      let verifiedSignerAddress: string | null = null;
      let sessionExpiresAt: number | null = null;
      try {
        const headers = req.headers || {};
        const cookies = parseCookieHeader(headers.cookie);
        const authorization = headers.authorization;
        const bearerToken = authorization?.startsWith("Bearer ")
          ? authorization.slice(7).trim()
          : undefined;
        const token = cookies[SESSION_COOKIE_NAME] || bearerToken;
        if (token) {
          const session = verifySessionToken(token);
          const authorization = await this.authorizeSession(session);
          sessionExpiresAt = this.sessionExpirationMilliseconds(session.exp);
          verifiedBusinessId = authorization.businessId;
          verifiedSignerAddress = authorization.signerAddress;
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
        signerAddress: verifiedSignerAddress,
        sessionExpiresAt,
        connectedAt: new Date(),
        lastPing: new Date(),
        messageCount: 0,
      };

      this.clients.set(clientId, client);

      logger.info("WebSocket client connected", {
        clientId,
        ip,
        businessId: verifiedBusinessId,
        totalClients: this.clients.size,
      });

      // Send welcome message
      this.sendToClient(client, {
        type: "system_event",
        channel: "system",
        payload: {
          event: "connected",
          clientId,
          availableChannels: [
            "payments",
            "compliance",
            "treasury",
            "streams",
            "alerts",
            "risk",
            "liquidity",
            "crosschain",
            "system",
          ],
        },
        timestamp: new Date().toISOString(),
        correlationId: crypto.randomUUID(),
      });

      ws.on("message", (data) => {
        return this.handleMessage(clientId, data.toString());
      });

      ws.on("close", () => {
        this.cleanupClient(clientId);
        logger.info("WebSocket client disconnected", {
          clientId,
          totalClients: this.clients.size,
        });
      });

      ws.on("pong", () => {
        client.lastPing = new Date();
      });

      ws.on("error", (error) => {
        logger.error("WebSocket client error", {
          clientId,
          error: error.message,
        });
        this.cleanupClient(clientId);
      });
    });

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    logger.info("WebSocket server attached", { path: "/ws" });
  }

  /**
   * Handle incoming client message.
   */
  private async handleMessage(clientId: string, raw: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (this.closeExpiredSession(clientId, client)) return;
    if (client.businessId && !(await this.revalidateClient(clientId, client)))
      return;

    // Rate limiting
    if (!this.checkRateLimit(clientId)) {
      this.sendToClient(client, {
        type: "system_event",
        channel: "system",
        payload: {
          event: "rate_limited",
          message: "Too many messages. Please slow down.",
        },
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
            responsePayload.reason =
              "Authentication required for non-system channels";
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
            payload: {
              event: "unsubscribed",
              channels: Array.from(client.channels),
            },
            timestamp: new Date().toISOString(),
            correlationId: crypto.randomUUID(),
          });
          break;

        case "authenticate":
          try {
            if (typeof message.token !== "string")
              throw new Error("Missing token");
            const session = verifySessionToken(message.token);
            const authorization = await this.authorizeSession(session);
            client.businessId = authorization.businessId;
            client.signerAddress = authorization.signerAddress;
            client.sessionExpiresAt = this.sessionExpirationMilliseconds(
              session.exp,
            );
            this.sendToClient(client, {
              type: "system_event",
              channel: "system",
              payload: {
                event: "authenticated",
                businessId: session.businessId,
              },
              timestamp: new Date().toISOString(),
              correlationId: crypto.randomUUID(),
            });
          } catch {
            this.clearAuthentication(client);
            this.sendToClient(client, {
              type: "system_event",
              channel: "system",
              payload: {
                event: "auth_failed",
                message: "Invalid or expired token",
              },
              timestamp: new Date().toISOString(),
              correlationId: crypto.randomUUID(),
            });
          }
          break;

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
  broadcast(
    channel: "system",
    type: WSEventType,
    payload: Record<string, unknown>,
  ): Promise<void>;
  broadcast(
    channel: WSTenantChannel,
    type: WSEventType,
    payload: Record<string, unknown>,
    targetBusinessId: string,
  ): Promise<void>;
  async broadcast(
    channel: WSChannel,
    type: WSEventType,
    payload: Record<string, unknown>,
    targetBusinessId?: string,
  ): Promise<void> {
    if (
      channel !== "system" &&
      (!targetBusinessId || !targetBusinessId.trim())
    ) {
      throw new TypeError(
        "targetBusinessId is required for non-system WebSocket broadcasts",
      );
    }

    const message: WSMessage = {
      type,
      channel,
      payload,
      timestamp: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
    };

    let sent = 0;
    for (const [clientId, client] of this.clients) {
      if (this.closeExpiredSession(clientId, client)) {
        continue;
      }
      if (
        channel !== "system" &&
        client.businessId &&
        !(await this.revalidateClient(clientId, client))
      ) {
        continue;
      }
      if (
        !client.channels.has(channel) ||
        client.ws.readyState !== WebSocket.OPEN
      ) {
        continue;
      }

      // Every non-system event is explicitly bound to one authenticated tenant.
      if (channel !== "system" && client.businessId !== targetBusinessId) {
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
      logger.debug("WebSocket broadcast");
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
      this.messageCounters.set(clientId, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      });
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
      this.clearAuthentication(client);
      client.channels.clear();
    }
    this.clients.delete(clientId);
    this.messageCounters.delete(clientId);
  }

  /**
   * Heartbeat: ping clients and remove stale connections.
   */
  private async heartbeat(): Promise<void> {
    const now = Date.now();

    for (const [id, client] of this.clients) {
      if (this.closeExpiredSession(id, client, now)) {
        continue;
      }
      if (client.businessId && !(await this.revalidateClient(id, client))) {
        continue;
      }
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

  private sessionExpirationMilliseconds(expirationSeconds: number): number {
    if (!Number.isSafeInteger(expirationSeconds) || expirationSeconds <= 0) {
      throw new Error("Session token is missing a valid expiration");
    }
    return expirationSeconds * 1000;
  }

  private clearAuthentication(client: WSClient): void {
    client.businessId = null;
    client.signerAddress = null;
    client.sessionExpiresAt = null;
    for (const channel of client.channels) {
      if (channel !== "system") client.channels.delete(channel);
    }
  }

  private closeExpiredSession(
    clientId: string,
    client: WSClient,
    now = Date.now(),
  ): boolean {
    if (
      !client.businessId ||
      (client.sessionExpiresAt !== null && now < client.sessionExpiresAt)
    ) {
      return false;
    }

    logger.info("WebSocket session expired", { clientId });
    try {
      client.ws.close(SESSION_EXPIRED_CLOSE_CODE, "Session expired");
    } catch (error) {
      logger.warn("Failed to close expired WebSocket session cleanly", {
        clientId,
        error: (error as Error).message,
      });
      try {
        client.ws.terminate();
      } catch (terminateError) {
        logger.warn("Failed to terminate expired WebSocket session", {
          clientId,
          error: (terminateError as Error).message,
        });
      }
    } finally {
      this.cleanupClient(clientId);
    }
    return true;
  }

  private async authorizeSession(session: JWTPayload): Promise<{
    businessId: string;
    signerAddress: string;
  }> {
    const business = await prisma.business.findUnique({
      where: { id: session.businessId },
      select: { id: true, address: true },
    });
    if (
      !business ||
      business.address.toLowerCase() !== session.sub.toLowerCase()
    ) {
      throw new Error("Session is not bound to the registered business wallet");
    }
    const current = await getCurrentBusinessRegistryAuthorization(
      business.address,
    );
    if (!current.active) {
      throw new Error(`Business is ${current.status.toLowerCase()}`);
    }
    return { businessId: business.id, signerAddress: current.wallet };
  }

  private async revalidateClient(
    clientId: string,
    client: WSClient,
  ): Promise<boolean> {
    try {
      if (!client.businessId || !client.signerAddress) return false;
      const business = await prisma.business.findUnique({
        where: { id: client.businessId },
        select: { id: true, address: true },
      });
      if (
        !business ||
        business.address.toLowerCase() !== client.signerAddress.toLowerCase()
      ) {
        throw new Error("Session business wallet binding changed");
      }
      const current = await getCurrentBusinessRegistryAuthorization(
        business.address,
      );
      if (!current.active || current.wallet !== client.signerAddress) {
        throw new Error(`Business is ${current.status.toLowerCase()}`);
      }
      return true;
    } catch (error) {
      logger.warn("WebSocket chain authorization revoked or unavailable", {
        clientId,
        businessId: client.businessId,
        error: (error as Error).message,
      });
      try {
        client.ws.close(
          AUTHORIZATION_REVOKED_CLOSE_CODE,
          "Business authorization revoked or unavailable",
        );
      } finally {
        this.cleanupClient(clientId);
      }
      return false;
    }
  }

  /**
   * Validate channel name.
   */
  private isValidChannel(channel: string): boolean {
    const valid: WSChannel[] = [
      "payments",
      "compliance",
      "treasury",
      "streams",
      "alerts",
      "risk",
      "liquidity",
      "crosschain",
      "system",
    ];
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
      avgMessageRate:
        this.clients.size > 0 ? totalMessages / this.clients.size : 0,
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
      this.clearAuthentication(client);
      client.channels.clear();
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
