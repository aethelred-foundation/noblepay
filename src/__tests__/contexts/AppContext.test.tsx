import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";

// --- Wagmi mock state (overridable per test) ---

let mockAccount = {
  address: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
  isConnected: true,
  isConnecting: false,
};
let mockChainId = 7332;
const mockConnect = jest.fn();
const mockConnectAsync = jest.fn(async () => ({}));
const mockDisconnect = jest.fn();
const mockDisconnectAsync = jest.fn(async () => {});
const mockReconnectAsync = jest.fn(async () => []);
const mockSwitchChain = jest.fn();
let mockNativeBalance: any = {
  value: BigInt(1_000_000_000_000_000_000),
  decimals: 18,
};
let mockUsdcBalance: any = { value: BigInt(5_000_000_000), decimals: 6 };
let mockUsdtBalance: any = { value: BigInt(2_500_000_000), decimals: 6 };
let mockBlockNumber: bigint | undefined = BigInt(42000);

jest.mock("wagmi", () => ({
  useAccount: () => mockAccount,
  useChainId: () => mockChainId,
  useConnect: () => ({
    connect: mockConnect,
    connectAsync: mockConnectAsync,
    connectors: [{ id: "injected", name: "MetaMask" }],
  }),
  useDisconnect: () => ({
    disconnect: mockDisconnect,
    disconnectAsync: mockDisconnectAsync,
  }),
  useReconnect: () => ({ reconnectAsync: mockReconnectAsync }),
  useSwitchChain: () => ({ switchChain: mockSwitchChain }),
  useBalance: (opts: any) => {
    if (!opts?.token) return { data: mockNativeBalance };
    if (opts.token === "0x0000000000000000000000000000000000000005")
      return { data: mockUsdcBalance };
    return { data: mockUsdtBalance };
  },
  useBlockNumber: () => ({ data: mockBlockNumber }),
}));

jest.mock("viem", () => ({
  formatUnits: (value: bigint, decimals: number) => {
    return (Number(value) / Math.pow(10, decimals)).toString();
  },
}));

jest.mock("@/config/wagmi", () => ({
  activeChain: { id: 7332, name: "Aethelred Testnet" },
}));

jest.mock("@/config/chains", () => ({
  CONTRACT_ADDRESSES: {
    usdcToken: "0x0000000000000000000000000000000000000005",
    usdtToken: "0x0000000000000000000000000000000000000006",
  },
}));

import { AppProvider, useApp } from "@/contexts/AppContext";

// Helper component to access context
function TestConsumer() {
  const ctx = useApp();
  return (
    <div>
      <span data-testid="connected">{String(ctx.wallet.connected)}</span>
      <span data-testid="address">{ctx.wallet.address}</span>
      <span data-testid="balance">{ctx.wallet.balance}</span>
      <span data-testid="usdcBalance">{ctx.wallet.usdcBalance}</span>
      <span data-testid="usdtBalance">{ctx.wallet.usdtBalance}</span>
      <span data-testid="isConnecting">{String(ctx.wallet.isConnecting)}</span>
      <span data-testid="isWrongNetwork">
        {String(ctx.wallet.isWrongNetwork)}
      </span>
      <span data-testid="chainId">{ctx.wallet.chainId}</span>
      <span data-testid="blockHeight">{ctx.realTime.blockHeight}</span>
      <span data-testid="searchOpen">{String(ctx.searchOpen)}</span>
      <span data-testid="notifCount">{ctx.notifications.length}</span>
      <button data-testid="connect-btn" onClick={ctx.connectWallet}>
        Connect
      </button>
      <button data-testid="disconnect-btn" onClick={ctx.disconnectWallet}>
        Disconnect
      </button>
      <button data-testid="switch-btn" onClick={ctx.switchNetwork}>
        Switch
      </button>
      <button data-testid="search-btn" onClick={() => ctx.setSearchOpen(true)}>
        Search
      </button>
      <button
        data-testid="add-notif"
        onClick={() => ctx.addNotification("info", "Test", "Test message")}
      >
        Add Notif
      </button>
      {ctx.notifications.map((n) => (
        <div key={n.id} data-testid={`notif-${n.id}`}>
          <span>{n.title}</span>
          <button
            data-testid={`remove-${n.id}`}
            onClick={() => ctx.removeNotification(n.id)}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

describe("AppContext", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockAccount = {
      address: "0x1234567890abcdef1234567890abcdef12345678" as `0x${string}`,
      isConnected: true,
      isConnecting: false,
    };
    mockChainId = 7332;
    mockNativeBalance = {
      value: BigInt(1_000_000_000_000_000_000),
      decimals: 18,
    };
    mockUsdcBalance = { value: BigInt(5_000_000_000), decimals: 6 };
    mockUsdtBalance = { value: BigInt(2_500_000_000), decimals: 6 };
    mockBlockNumber = BigInt(42000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("provides wallet state when connected", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("connected")).toHaveTextContent("true");
    expect(screen.getByTestId("address")).toHaveTextContent(
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    expect(screen.getByTestId("balance")).toHaveTextContent("1");
    expect(screen.getByTestId("usdcBalance")).toHaveTextContent("5000");
    expect(screen.getByTestId("usdtBalance")).toHaveTextContent("2500");
    expect(screen.getByTestId("isWrongNetwork")).toHaveTextContent("false");
  });

  it("provides default wallet state when disconnected", () => {
    mockAccount = {
      address: undefined as any,
      isConnected: false,
      isConnecting: false,
    };
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("connected")).toHaveTextContent("false");
    expect(screen.getByTestId("address")).toHaveTextContent("");
    expect(screen.getByTestId("balance")).toHaveTextContent("0");
  });

  it("shows isConnecting state", () => {
    mockAccount = {
      address: undefined as any,
      isConnected: false,
      isConnecting: true,
    };
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("isConnecting")).toHaveTextContent("true");
  });

  it("detects wrong network", () => {
    mockChainId = 9999;
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("isWrongNetwork")).toHaveTextContent("true");
  });

  it("handles zero balances when balance data is null", () => {
    mockNativeBalance = null;
    mockUsdcBalance = null;
    mockUsdtBalance = null;
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("balance")).toHaveTextContent("0");
    expect(screen.getByTestId("usdcBalance")).toHaveTextContent("0");
    expect(screen.getByTestId("usdtBalance")).toHaveTextContent("0");
  });

  it("connectWallet calls wagmi connectAsync when a provider is injected", async () => {
    const savedAccount = mockAccount;
    mockAccount = { ...mockAccount, isConnected: false };
    mockConnectAsync.mockClear();
    (window as unknown as { ethereum?: unknown }).ethereum = {};
    try {
      render(
        <AppProvider>
          <TestConsumer />
        </AppProvider>,
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("connect-btn"));
      });
      expect(mockConnectAsync).toHaveBeenCalledWith(
        expect.objectContaining({ connector: expect.any(Object), chainId: 7332 }),
      );
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum;
      mockAccount = savedAccount;
    }
  });

  it("adopts an already-connected session instead of erroring (shared-origin residue)", async () => {
    const savedAccount = mockAccount;
    mockAccount = { ...mockAccount, isConnected: false };
    mockConnectAsync.mockClear();
    mockReconnectAsync.mockClear();
    mockConnectAsync.mockRejectedValueOnce(
      new Error("Connector already connected. Version: @wagmi/core@2.22.1"),
    );
    (window as unknown as { ethereum?: unknown }).ethereum = {};
    try {
      render(
        <AppProvider>
          <TestConsumer />
        </AppProvider>,
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("connect-btn"));
      });
      expect(mockReconnectAsync).toHaveBeenCalledWith(
        expect.objectContaining({ connectors: [expect.any(Object)] }),
      );
      // adopted silently — no error notification
      expect(screen.getByTestId("notifCount")).toHaveTextContent("0");
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum;
      mockAccount = savedAccount;
      mockConnectAsync.mockReset();
      mockConnectAsync.mockResolvedValue({});
    }
  });

  it("resets the connector and retries once when adoption fails", async () => {
    const savedAccount = mockAccount;
    mockAccount = { ...mockAccount, isConnected: false };
    mockConnectAsync.mockClear();
    mockDisconnectAsync.mockClear();
    mockConnectAsync.mockRejectedValueOnce(new Error("Connector already connected."));
    mockReconnectAsync.mockRejectedValueOnce(new Error("no persisted session"));
    (window as unknown as { ethereum?: unknown }).ethereum = {};
    try {
      render(
        <AppProvider>
          <TestConsumer />
        </AppProvider>,
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("connect-btn"));
      });
      expect(mockDisconnectAsync).toHaveBeenCalledTimes(1);
      expect(mockConnectAsync).toHaveBeenCalledTimes(2); // initial + clean retry
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum;
      mockAccount = savedAccount;
      mockConnectAsync.mockReset();
      mockConnectAsync.mockResolvedValue({});
      mockReconnectAsync.mockReset();
      mockReconnectAsync.mockResolvedValue([]);
    }
  });

  it("connectWallet surfaces a notification instead of a silent no-op without a provider", async () => {
    // Remove the injected provider (extension missing/disabled for this site).
    mockConnectAsync.mockClear();
    const saved = (window as unknown as { ethereum?: unknown }).ethereum;
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId("connect-btn"));
      });
      expect(mockConnectAsync).not.toHaveBeenCalled();
      expect(screen.getByTestId("notifCount")).not.toHaveTextContent(/^0$/);
    } finally {
      if (saved !== undefined) (window as unknown as { ethereum?: unknown }).ethereum = saved;
    }
  });

  it("disconnectWallet calls wagmi disconnect", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId("disconnect-btn"));
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("switchNetwork calls switchChain", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId("switch-btn"));
    expect(mockSwitchChain).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 7332 }),
    );
  });

  it("updates blockHeight from blockNumber", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("blockHeight")).toHaveTextContent("42000");
  });

  it("sets searchOpen state", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("searchOpen")).toHaveTextContent("false");
    fireEvent.click(screen.getByTestId("search-btn"));
    expect(screen.getByTestId("searchOpen")).toHaveTextContent("true");
  });

  it("adds and removes notifications", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId("notifCount")).toHaveTextContent("0");

    act(() => {
      fireEvent.click(screen.getByTestId("add-notif"));
    });

    expect(screen.getByTestId("notifCount")).toHaveTextContent("1");
    expect(screen.getByText("Test")).toBeInTheDocument();

    // Remove the notification
    const removeButtons = screen.getAllByText("Remove");
    act(() => {
      fireEvent.click(removeButtons[0]);
    });

    expect(screen.getByTestId("notifCount")).toHaveTextContent("0");
  });

  it("auto-removes notifications after 5 seconds", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByTestId("add-notif"));
    });

    expect(screen.getByTestId("notifCount")).toHaveTextContent("1");

    act(() => {
      jest.advanceTimersByTime(5100);
    });

    expect(screen.getByTestId("notifCount")).toHaveTextContent("0");
  });

  it("cleans up timers on unmount", () => {
    const { unmount } = render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    // Add a notification to create a timer
    act(() => {
      fireEvent.click(screen.getByTestId("add-notif"));
    });

    // Unmount should not throw (timers are cleaned up)
    expect(() => unmount()).not.toThrow();
  });

  it("provides default payment and compliance state", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    // Payment and compliance defaults are provided - just verify no crash
    expect(screen.getByTestId("connected")).toBeInTheDocument();
  });

  it("handles null USDC token address gracefully", () => {
    const chains = require("@/config/chains");
    const origUsdc = chains.CONTRACT_ADDRESSES.usdcToken;
    chains.CONTRACT_ADDRESSES.usdcToken = "";
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    expect(screen.getByTestId("connected")).toBeInTheDocument();
    chains.CONTRACT_ADDRESSES.usdcToken = origUsdc;
  });

  it("handles null USDT token address gracefully", () => {
    const chains = require("@/config/chains");
    const origUsdt = chains.CONTRACT_ADDRESSES.usdtToken;
    chains.CONTRACT_ADDRESSES.usdtToken = "";
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    expect(screen.getByTestId("connected")).toBeInTheDocument();
    chains.CONTRACT_ADDRESSES.usdtToken = origUsdt;
  });

  it("removes notification before auto-timeout fires", () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByTestId("add-notif"));
    });

    expect(screen.getByTestId("notifCount")).toHaveTextContent("1");

    // Remove manually before the 5s timer fires
    const removeButtons = screen.getAllByText("Remove");
    act(() => {
      fireEvent.click(removeButtons[0]);
    });

    expect(screen.getByTestId("notifCount")).toHaveTextContent("0");

    // Advance timers — the cleanup function should have cleared the timer
    act(() => {
      jest.advanceTimersByTime(6000);
    });

    // Should still be 0
    expect(screen.getByTestId("notifCount")).toHaveTextContent("0");
  });

  it("connectWallet uses fallback connector when no injected connector", async () => {
    const wagmi = require("wagmi");
    const origConnect = wagmi.useConnect;
    const fallbackConnectAsync = jest.fn(async () => ({}));
    wagmi.useConnect = () => ({
      connect: jest.fn(),
      connectAsync: fallbackConnectAsync,
      connectors: [{ id: "walletConnect", name: "WalletConnect" }],
    });
    const savedAccount = mockAccount;
    mockAccount = { ...mockAccount, isConnected: false };

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    (window as unknown as { ethereum?: unknown }).ethereum = {};
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId("connect-btn"));
      });
      expect(fallbackConnectAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          connector: { id: "walletConnect", name: "WalletConnect" },
        }),
      );
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum;
      mockAccount = savedAccount;
      wagmi.useConnect = origConnect;
    }
  });

  it("connectWallet does nothing when no connectors available", async () => {
    const wagmi = require("wagmi");
    const origConnect = wagmi.useConnect;
    const noopConnectAsync = jest.fn(async () => ({}));
    wagmi.useConnect = () => ({
      connect: jest.fn(),
      connectAsync: noopConnectAsync,
      connectors: [],
    });
    const savedAccount = mockAccount;
    mockAccount = { ...mockAccount, isConnected: false };
    (window as unknown as { ethereum?: unknown }).ethereum = {};

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId("connect-btn"));
      });
      expect(noopConnectAsync).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { ethereum?: unknown }).ethereum;
      mockAccount = savedAccount;
      wagmi.useConnect = origConnect;
    }
  });
});

describe("useApp", () => {
  it("throws when used outside AppProvider", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      "useApp must be used within an <AppProvider>",
    );
    consoleError.mockRestore();
  });
});
