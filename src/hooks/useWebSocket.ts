import { useCallback, useEffect, useRef, useState } from "react";

export type WSConnectionState =
  "connecting" | "connected" | "disconnected" | "reconnecting";

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

export interface WSEvent<T = Record<string, unknown>> {
  type: WSEventType;
  channel: WSChannel;
  payload: T;
  timestamp: string;
  correlationId: string;
}

export type WSSubscriptionCallback<T = Record<string, unknown>> = (
  event: WSEvent<T>,
) => void;

const FALLBACK_WS_URL = "ws://localhost:4008/ws";
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;

const EVENT_TYPES = new Set<WSEventType>([
  "payment_update",
  "compliance_decision",
  "stream_tick",
  "alert",
  "risk_update",
  "treasury_event",
  "liquidity_update",
  "crosschain_update",
  "system_event",
]);

const CHANNELS = new Set<WSChannel>([
  "payments",
  "compliance",
  "treasury",
  "streams",
  "alerts",
  "risk",
  "liquidity",
  "crosschain",
  "system",
]);

function ensureWsPath(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    }
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/ws";
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

function defaultWebSocketUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return ensureWsPath(configured);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl) return ensureWsPath(apiUrl);

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }

  return FALLBACK_WS_URL;
}

function isServerEvent(value: unknown): value is WSEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<WSEvent>;
  return (
    typeof event.type === "string" &&
    EVENT_TYPES.has(event.type as WSEventType) &&
    typeof event.channel === "string" &&
    CHANNELS.has(event.channel as WSChannel) &&
    !!event.payload &&
    typeof event.payload === "object" &&
    typeof event.timestamp === "string" &&
    typeof event.correlationId === "string"
  );
}

/**
 * Cookie-authenticated NoblePay WebSocket client.
 *
 * Browser WebSocket handshakes automatically include eligible session cookies;
 * no bearer token is put in the URL or a browser-readable store.
 */
export function useWebSocket(url?: string) {
  const wsUrl = ensureWsPath(url || defaultWebSocketUrl());
  const [connectionState, setConnectionState] =
    useState<WSConnectionState>("disconnected");
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(false);
  const manualDisconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectRef = useRef<() => void>(() => undefined);
  const subscriptionsRef = useRef<Map<WSChannel, Set<WSSubscriptionCallback>>>(
    new Map(),
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "ping" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, [stopHeartbeat]);

  const dispatch = useCallback((event: WSEvent) => {
    setLastEvent(event);
    const subscribers = subscriptionsRef.current.get(event.channel);
    subscribers?.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error("[NoblePay WS] Subscriber error:", error);
      }
    });
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    clearReconnectTimer();
    manualDisconnectRef.current = false;
    setConnectionState(
      reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting",
    );

    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        if (!mountedRef.current || wsRef.current !== socket) {
          socket.close();
          return;
        }

        reconnectAttemptsRef.current = 0;
        setReconnectAttempts(0);
        setConnectionState("connected");
        startHeartbeat();

        const channels = Array.from(subscriptionsRef.current.keys());
        if (channels.length > 0) {
          socket.send(JSON.stringify({ action: "subscribe", channels }));
        }
      };

      socket.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        try {
          const event: unknown = JSON.parse(message.data);
          if (isServerEvent(event)) dispatch(event);
        } catch {
          // The server protocol is JSON-only; malformed frames are ignored.
        }
      };

      socket.onerror = () => {
        // The close event owns state changes and reconnect scheduling.
      };

      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        stopHeartbeat();

        if (!mountedRef.current || manualDisconnectRef.current) {
          setConnectionState("disconnected");
          return;
        }

        const nextAttempt = reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = nextAttempt;
        setReconnectAttempts(nextAttempt);

        if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
          setConnectionState("disconnected");
          return;
        }

        setConnectionState("reconnecting");
        const delay = RECONNECT_DELAY_MS * Math.min(nextAttempt, 5);
        reconnectTimerRef.current = setTimeout(
          () => connectRef.current(),
          delay,
        );
      };
    } catch (error) {
      console.error("[NoblePay WS] Connection error:", error);
      setConnectionState("disconnected");
    }
  }, [clearReconnectTimer, dispatch, startHeartbeat, stopHeartbeat, wsUrl]);

  connectRef.current = connect;

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      manualDisconnectRef.current = true;
      clearReconnectTimer();
      stopHeartbeat();
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    };
  }, [clearReconnectTimer, connect, stopHeartbeat]);

  const subscribe = useCallback(
    <T = Record<string, unknown>>(
      channel: WSChannel,
      callback: WSSubscriptionCallback<T>,
    ) => {
      const existing = subscriptionsRef.current.get(channel);
      const isNewChannel = !existing;
      const subscribers = existing || new Set<WSSubscriptionCallback>();
      subscribers.add(callback as WSSubscriptionCallback);
      subscriptionsRef.current.set(channel, subscribers);

      if (isNewChannel && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: "subscribe", channel }));
      }

      return () => {
        const current = subscriptionsRef.current.get(channel);
        current?.delete(callback as WSSubscriptionCallback);
        if (current?.size === 0) {
          subscriptionsRef.current.delete(channel);
          if (
            channel !== "system" &&
            wsRef.current?.readyState === WebSocket.OPEN
          ) {
            wsRef.current.send(
              JSON.stringify({ action: "unsubscribe", channel }),
            );
          }
        }
      };
    },
    [],
  );

  const unsubscribe = useCallback(
    <T = Record<string, unknown>>(
      channel: WSChannel,
      callback: WSSubscriptionCallback<T>,
    ) => {
      const subscribers = subscriptionsRef.current.get(channel);
      subscribers?.delete(callback as WSSubscriptionCallback);
      if (subscribers?.size === 0) {
        subscriptionsRef.current.delete(channel);
        if (
          channel !== "system" &&
          wsRef.current?.readyState === WebSocket.OPEN
        ) {
          wsRef.current.send(
            JSON.stringify({ action: "unsubscribe", channel }),
          );
        }
      }
    },
    [],
  );

  const send = useCallback((data: Record<string, unknown>): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify(data));
    return true;
  }, []);

  const disconnect = useCallback(() => {
    manualDisconnectRef.current = true;
    clearReconnectTimer();
    stopHeartbeat();
    reconnectAttemptsRef.current = 0;
    setReconnectAttempts(0);
    setConnectionState("disconnected");
    const socket = wsRef.current;
    wsRef.current = null;
    socket?.close();
  }, [clearReconnectTimer, stopHeartbeat]);

  const reconnect = useCallback(() => {
    disconnect();
    manualDisconnectRef.current = false;
    reconnectTimerRef.current = setTimeout(() => connectRef.current(), 100);
  }, [disconnect]);

  return {
    connectionState,
    lastEvent,
    reconnectAttempts,
    subscribe,
    unsubscribe,
    send,
    disconnect,
    reconnect,
  };
}
