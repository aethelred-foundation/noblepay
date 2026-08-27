import { act, renderHook } from "@testing-library/react";
import { useWebSocket } from "@/hooks/useWebSocket";

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly constructorArguments: unknown[];
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: string[] = [];

  constructor(...args: unknown[]) {
    this.url = String(args[0]);
    this.constructorArguments = args;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.readyState !== MockWebSocket.CONNECTING) return;
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event("open"));
    }, 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  simulateClose() {
    this.close();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

const serverEvent = {
  type: "payment_update",
  channel: "payments",
  payload: { id: "pay-001", status: "SETTLED" },
  timestamp: "2026-07-21T10:00:00.000Z",
  correlationId: "corr-001",
} as const;

describe("useWebSocket", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it("connects to the backend /ws path without putting auth in the URL", () => {
    const { result } = renderHook(() => useWebSocket("ws://api.example.test"));

    expect(result.current.connectionState).toBe("connecting");
    expect(MockWebSocket.instances[0].url).toBe("ws://api.example.test/ws");
    expect(MockWebSocket.instances[0].constructorArguments).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).not.toContain("token=");

    act(() => jest.runOnlyPendingTimers());
    expect(result.current.connectionState).toBe("connected");
  });

  it("accepts the server envelope and dispatches by channel", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    const payments = jest.fn();
    const compliance = jest.fn();
    act(() => jest.advanceTimersByTime(1));

    act(() => {
      result.current.subscribe("payments", payments);
      result.current.subscribe("compliance", compliance);
      MockWebSocket.instances[0].simulateMessage(serverEvent);
    });

    expect(result.current.lastEvent).toEqual(serverEvent);
    expect(payments).toHaveBeenCalledWith(serverEvent);
    expect(compliance).not.toHaveBeenCalled();
  });

  it("ignores malformed and legacy event envelopes", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    act(() => jest.advanceTimersByTime(1));

    act(() => {
      MockWebSocket.instances[0].simulateMessage({
        type: "payment:settled",
        data: { id: "legacy" },
        timestamp: Date.now(),
      });
      MockWebSocket.instances[0].onmessage?.(
        new MessageEvent("message", { data: "not-json" }),
      );
    });

    expect(result.current.lastEvent).toBeNull();
  });

  it("uses action/channel for subscribe and unsubscribe", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    const callback = jest.fn();
    act(() => jest.advanceTimersByTime(1));

    act(() => result.current.subscribe("payments", callback));
    act(() => result.current.unsubscribe("payments", callback));

    const messages = MockWebSocket.instances[0].sent.map((value) =>
      JSON.parse(value),
    );
    expect(messages).toContainEqual({
      action: "subscribe",
      channel: "payments",
    });
    expect(messages).toContainEqual({
      action: "unsubscribe",
      channel: "payments",
    });
  });

  it("returns an unsubscribe cleanup from subscribe", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    const callback = jest.fn();
    act(() => jest.advanceTimersByTime(1));

    let cleanup = () => undefined;
    act(() => {
      cleanup = result.current.subscribe("payments", callback);
      cleanup();
      MockWebSocket.instances[0].simulateMessage(serverEvent);
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it("re-subscribes with the backend channels field after reconnect", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    act(() => jest.advanceTimersByTime(1));
    act(() => result.current.subscribe("payments", jest.fn()));

    act(() => MockWebSocket.instances[0].simulateClose());
    expect(result.current.connectionState).toBe("reconnecting");
    expect(result.current.reconnectAttempts).toBe(1);

    act(() => jest.advanceTimersByTime(3_001));
    const replacement = MockWebSocket.instances[1];
    const messages = replacement.sent.map((value) => JSON.parse(value));
    expect(messages).toContainEqual({
      action: "subscribe",
      channels: ["payments"],
    });
  });

  it("sends heartbeat using the server ping action", () => {
    renderHook(() => useWebSocket("ws://test/ws"));
    act(() => jest.advanceTimersByTime(1));
    const socket = MockWebSocket.instances[0];

    act(() => jest.advanceTimersByTime(30_000));

    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({
      action: "ping",
    });
  });

  it("does not reconnect after a manual disconnect", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    act(() => jest.advanceTimersByTime(1));

    act(() => result.current.disconnect());
    act(() => jest.advanceTimersByTime(60_000));

    expect(result.current.connectionState).toBe("disconnected");
    expect(result.current.reconnectAttempts).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("supports an explicit manual reconnect", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    act(() => jest.advanceTimersByTime(1));

    act(() => result.current.reconnect());
    act(() => jest.advanceTimersByTime(101));

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(result.current.connectionState).toBe("connected");
  });

  it("reports whether an application message was sent", () => {
    const { result } = renderHook(() => useWebSocket("ws://test/ws"));
    expect(result.current.send({ action: "test" })).toBe(false);
    act(() => jest.advanceTimersByTime(1));

    let sent = false;
    act(() => {
      sent = result.current.send({ action: "test", payload: "hello" });
    });

    expect(sent).toBe(true);
    expect(JSON.parse(MockWebSocket.instances[0].sent.at(-1)!)).toEqual({
      action: "test",
      payload: "hello",
    });
  });

  it("closes the active socket on unmount", () => {
    const { unmount } = renderHook(() => useWebSocket("ws://test/ws"));
    act(() => jest.advanceTimersByTime(1));

    unmount();

    expect(MockWebSocket.instances[0].readyState).toBe(MockWebSocket.CLOSED);
  });
});
