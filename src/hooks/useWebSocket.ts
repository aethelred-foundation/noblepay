/**
 * WebSocket Hook — Real-time event subscription for NoblePay.
 *
 * Manages a WebSocket connection to the NoblePay event server,
 * with automatic reconnection, typed event subscriptions, and
 * connection status tracking.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** WebSocket connection state */
export type WSConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

/** Supported WebSocket event types */
export type WSEventType =
  | 'payment:initiated'
  | 'payment:settled'
  | 'payment:flagged'
  | 'compliance:screening'
  | 'compliance:decision'
  | 'stream:update'
  | 'pool:tvl'
  | 'fx:rate'
  | 'crosschain:status'
  | 'treasury:proposal'
  | 'invoice:status';

/** WebSocket event payload */
export interface WSEvent<T = unknown> {
  type: WSEventType;
  data: T;
  timestamp: number;
}

/** Subscription callback */
export type WSSubscriptionCallback<T = unknown> = (event: WSEvent<T>) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_WS_URL = 'ws://localhost:3003';
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// useWebSocket — WebSocket connection with subscriptions
// ---------------------------------------------------------------------------

export function useWebSocket(url?: string) {
  const wsUrl = url || process.env.NEXT_PUBLIC_WS_URL || DEFAULT_WS_URL;

  const [connectionState, setConnectionState] = useState<WSConnectionState>('disconnected');
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const subscriptionsRef = useRef<Map<WSEventType, Set<WSSubscriptionCallback>>>(new Map());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  // Dispatch event to all matching subscribers
  const dispatch = useCallback((event: WSEvent) => {
    setLastEvent(event);
    const subs = subscriptionsRef.current.get(event.type);
    if (subs) {
      subs.forEach((cb) => {
        try {
          cb(event);
        } catch (err) {
          console.error('[NoblePay WS] Subscriber error:', err);
        }
      });
    }
  }, []);

  // Start heartbeat to keep connection alive
  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, []);

  // Stop heartbeat
  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  // Connect to WebSocket server
  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      setConnectionState('connecting');
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        setConnectionState('connected');
        setReconnectAttempts(0);
        startHeartbeat();

        // Re-subscribe to all active event types
        const types = Array.from(subscriptionsRef.current.keys());
        if (types.length > 0) {
          ws.send(JSON.stringify({ action: 'subscribe', types }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as WSEvent;
          if (parsed.type) {
            dispatch(parsed);
          }
        } catch {
          // Ignore non-JSON messages (e.g. pong)
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnectionState('disconnected');
        stopHeartbeat();
        wsRef.current = null;

        // Auto-reconnect
        setReconnectAttempts((prev) => {
          const next = prev + 1;
          if (next <= MAX_RECONNECT_ATTEMPTS) {
            setConnectionState('reconnecting');
            const delay = RECONNECT_DELAY_MS * Math.min(next, 5);
            reconnectTimerRef.current = setTimeout(connect, delay);
          }
          return next;
        });
      };

      ws.onerror = () => {
        // onclose will fire after onerror, which handles reconnection
      };

      wsRef.current = ws;
    } catch (err) {
      console.error('[NoblePay WS] Connection error:', err);
      setConnectionState('disconnected');
    }
  }, [wsUrl, dispatch, startHeartbeat, stopHeartbeat]);

  // Initialize connection on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      stopHeartbeat();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, stopHeartbeat]);

  // Subscribe to a specific event type
  const subscribe = useCallback(
    <T = unknown>(type: WSEventType, callback: WSSubscriptionCallback<T>) => {
      if (!subscriptionsRef.current.has(type)) {
        subscriptionsRef.current.set(type, new Set());
      }
      subscriptionsRef.current.get(type)!.add(callback as WSSubscriptionCallback);

      // Tell server about new subscription
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ action: 'subscribe', types: [type] }));
      }
    },
    [],
  );

  // Unsubscribe from a specific event type
  const unsubscribe = useCallback(
    <T = unknown>(type: WSEventType, callback: WSSubscriptionCallback<T>) => {
      const subs = subscriptionsRef.current.get(type);
      if (subs) {
        subs.delete(callback as WSSubscriptionCallback);
        if (subs.size === 0) {
          subscriptionsRef.current.delete(type);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ action: 'unsubscribe', types: [type] }));
          }
        }
      }
    },
    [],
  );

  // Send a message to the server
  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  // Manual disconnect
  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    stopHeartbeat();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionState('disconnected');
    setReconnectAttempts(0);
  }, [stopHeartbeat]);

  // Manual reconnect
  const reconnect = useCallback(() => {
    disconnect();
    setReconnectAttempts(0);
    setTimeout(connect, 100);
  }, [disconnect, connect]);

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
