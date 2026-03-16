import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';

// --- Wagmi mock state (overridable per test) ---

let mockAccount = {
  address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
  isConnected: true,
  isConnecting: false,
};
let mockChainId = 7332;
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockSwitchChain = jest.fn();
let mockNativeBalance: any = { value: BigInt(1_000_000_000_000_000_000), decimals: 18 };
let mockUsdcBalance: any = { value: BigInt(5_000_000_000), decimals: 6 };
let mockUsdtBalance: any = { value: BigInt(2_500_000_000), decimals: 6 };
let mockBlockNumber: bigint | undefined = BigInt(42000);

jest.mock('wagmi', () => ({
  useAccount: () => mockAccount,
  useChainId: () => mockChainId,
  useConnect: () => ({ connect: mockConnect, connectors: [{ id: 'injected', name: 'MetaMask' }] }),
  useDisconnect: () => ({ disconnect: mockDisconnect }),
  useSwitchChain: () => ({ switchChain: mockSwitchChain }),
  useBalance: (opts: any) => {
    if (!opts?.token) return { data: mockNativeBalance };
    if (opts.token === '0x0000000000000000000000000000000000000005') return { data: mockUsdcBalance };
    return { data: mockUsdtBalance };
  },
  useBlockNumber: () => ({ data: mockBlockNumber }),
}));

jest.mock('viem', () => ({
  formatUnits: (value: bigint, decimals: number) => {
    return (Number(value) / Math.pow(10, decimals)).toString();
  },
}));

jest.mock('@/config/wagmi', () => ({
  activeChain: { id: 7332, name: 'Aethelred Testnet' },
}));

jest.mock('@/config/chains', () => ({
  CONTRACT_ADDRESSES: {
    usdcToken: '0x0000000000000000000000000000000000000005',
    usdtToken: '0x0000000000000000000000000000000000000006',
  },
}));

import { AppProvider, useApp } from '@/contexts/AppContext';

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
      <span data-testid="isWrongNetwork">{String(ctx.wallet.isWrongNetwork)}</span>
      <span data-testid="chainId">{ctx.wallet.chainId}</span>
      <span data-testid="blockHeight">{ctx.realTime.blockHeight}</span>
      <span data-testid="searchOpen">{String(ctx.searchOpen)}</span>
      <span data-testid="notifCount">{ctx.notifications.length}</span>
      <button data-testid="connect-btn" onClick={ctx.connectWallet}>Connect</button>
      <button data-testid="disconnect-btn" onClick={ctx.disconnectWallet}>Disconnect</button>
      <button data-testid="switch-btn" onClick={ctx.switchNetwork}>Switch</button>
      <button data-testid="search-btn" onClick={() => ctx.setSearchOpen(true)}>Search</button>
      <button data-testid="add-notif" onClick={() => ctx.addNotification('info', 'Test', 'Test message')}>Add Notif</button>
      {ctx.notifications.map((n) => (
        <div key={n.id} data-testid={`notif-${n.id}`}>
          <span>{n.title}</span>
          <button data-testid={`remove-${n.id}`} onClick={() => ctx.removeNotification(n.id)}>Remove</button>
        </div>
      ))}
    </div>
  );
}

describe('AppContext', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockAccount = {
      address: '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`,
      isConnected: true,
      isConnecting: false,
    };
    mockChainId = 7332;
    mockNativeBalance = { value: BigInt(1_000_000_000_000_000_000), decimals: 18 };
    mockUsdcBalance = { value: BigInt(5_000_000_000), decimals: 6 };
    mockUsdtBalance = { value: BigInt(2_500_000_000), decimals: 6 };
    mockBlockNumber = BigInt(42000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('provides wallet state when connected', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('connected')).toHaveTextContent('true');
    expect(screen.getByTestId('address')).toHaveTextContent('0x1234567890abcdef1234567890abcdef12345678');
    expect(screen.getByTestId('balance')).toHaveTextContent('1');
    expect(screen.getByTestId('usdcBalance')).toHaveTextContent('5000');
    expect(screen.getByTestId('usdtBalance')).toHaveTextContent('2500');
    expect(screen.getByTestId('isWrongNetwork')).toHaveTextContent('false');
  });

  it('provides default wallet state when disconnected', () => {
    mockAccount = { address: undefined as any, isConnected: false, isConnecting: false };
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('connected')).toHaveTextContent('false');
    expect(screen.getByTestId('address')).toHaveTextContent('');
    expect(screen.getByTestId('balance')).toHaveTextContent('0');
  });

  it('shows isConnecting state', () => {
    mockAccount = { address: undefined as any, isConnected: false, isConnecting: true };
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('isConnecting')).toHaveTextContent('true');
  });

  it('detects wrong network', () => {
    mockChainId = 9999;
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('isWrongNetwork')).toHaveTextContent('true');
  });

  it('handles zero balances when balance data is null', () => {
    mockNativeBalance = null;
    mockUsdcBalance = null;
    mockUsdtBalance = null;
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('balance')).toHaveTextContent('0');
    expect(screen.getByTestId('usdcBalance')).toHaveTextContent('0');
    expect(screen.getByTestId('usdtBalance')).toHaveTextContent('0');
  });

  it('connectWallet calls wagmi connect', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId('connect-btn'));
    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ connector: expect.any(Object) }));
  });

  it('disconnectWallet calls wagmi disconnect', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId('disconnect-btn'));
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('switchNetwork calls switchChain', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId('switch-btn'));
    expect(mockSwitchChain).toHaveBeenCalledWith(expect.objectContaining({ chainId: 7332 }));
  });

  it('updates blockHeight from blockNumber', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('blockHeight')).toHaveTextContent('42000');
  });

  it('sets searchOpen state', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('searchOpen')).toHaveTextContent('false');
    fireEvent.click(screen.getByTestId('search-btn'));
    expect(screen.getByTestId('searchOpen')).toHaveTextContent('true');
  });

  it('adds and removes notifications', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    expect(screen.getByTestId('notifCount')).toHaveTextContent('0');

    act(() => {
      fireEvent.click(screen.getByTestId('add-notif'));
    });

    expect(screen.getByTestId('notifCount')).toHaveTextContent('1');
    expect(screen.getByText('Test')).toBeInTheDocument();

    // Remove the notification
    const removeButtons = screen.getAllByText('Remove');
    act(() => {
      fireEvent.click(removeButtons[0]);
    });

    expect(screen.getByTestId('notifCount')).toHaveTextContent('0');
  });

  it('auto-removes notifications after 5 seconds', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByTestId('add-notif'));
    });

    expect(screen.getByTestId('notifCount')).toHaveTextContent('1');

    act(() => {
      jest.advanceTimersByTime(5100);
    });

    expect(screen.getByTestId('notifCount')).toHaveTextContent('0');
  });

  it('cleans up timers on unmount', () => {
    const { unmount } = render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    // Add a notification to create a timer
    act(() => {
      fireEvent.click(screen.getByTestId('add-notif'));
    });

    // Unmount should not throw (timers are cleaned up)
    expect(() => unmount()).not.toThrow();
  });

  it('provides default payment and compliance state', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    // Payment and compliance defaults are provided - just verify no crash
    expect(screen.getByTestId('connected')).toBeInTheDocument();
  });

  it('handles null USDC token address gracefully', () => {
    const chains = require('@/config/chains');
    const origUsdc = chains.CONTRACT_ADDRESSES.usdcToken;
    chains.CONTRACT_ADDRESSES.usdcToken = '';
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    expect(screen.getByTestId('connected')).toBeInTheDocument();
    chains.CONTRACT_ADDRESSES.usdcToken = origUsdc;
  });

  it('handles null USDT token address gracefully', () => {
    const chains = require('@/config/chains');
    const origUsdt = chains.CONTRACT_ADDRESSES.usdtToken;
    chains.CONTRACT_ADDRESSES.usdtToken = '';
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );
    expect(screen.getByTestId('connected')).toBeInTheDocument();
    chains.CONTRACT_ADDRESSES.usdtToken = origUsdt;
  });

  it('removes notification before auto-timeout fires', () => {
    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    act(() => {
      fireEvent.click(screen.getByTestId('add-notif'));
    });

    expect(screen.getByTestId('notifCount')).toHaveTextContent('1');

    // Remove manually before the 5s timer fires
    const removeButtons = screen.getAllByText('Remove');
    act(() => {
      fireEvent.click(removeButtons[0]);
    });

    expect(screen.getByTestId('notifCount')).toHaveTextContent('0');

    // Advance timers — the cleanup function should have cleared the timer
    act(() => {
      jest.advanceTimersByTime(6000);
    });

    // Should still be 0
    expect(screen.getByTestId('notifCount')).toHaveTextContent('0');
  });

  it('connectWallet uses fallback connector when no injected connector', () => {
    const wagmi = require('wagmi');
    const origConnect = wagmi.useConnect;
    const fallbackConnect = jest.fn();
    wagmi.useConnect = () => ({
      connect: fallbackConnect,
      connectors: [{ id: 'walletConnect', name: 'WalletConnect' }],
    });

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId('connect-btn'));
    expect(fallbackConnect).toHaveBeenCalledWith(
      expect.objectContaining({ connector: { id: 'walletConnect', name: 'WalletConnect' } }),
    );

    wagmi.useConnect = origConnect;
  });

  it('connectWallet does nothing when no connectors available', () => {
    const wagmi = require('wagmi');
    const origConnect = wagmi.useConnect;
    const noopConnect = jest.fn();
    wagmi.useConnect = () => ({
      connect: noopConnect,
      connectors: [],
    });

    render(
      <AppProvider>
        <TestConsumer />
      </AppProvider>,
    );

    fireEvent.click(screen.getByTestId('connect-btn'));
    expect(noopConnect).not.toHaveBeenCalled();

    wagmi.useConnect = origConnect;
  });
});

describe('useApp', () => {
  it('throws when used outside AppProvider', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow('useApp must be used within an <AppProvider>');
    consoleError.mockRestore();
  });
});
