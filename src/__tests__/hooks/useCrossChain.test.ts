import { renderHook, act } from '@testing-library/react';
import { useCrossChain } from '@/hooks/useCrossChain';

describe('useCrossChain', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useCrossChain());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.chains).toEqual([]);
    expect(result.current.transfers).toEqual([]);
    expect(result.current.relayNodes).toEqual([]);
  });

  it('loads mock data after timeout', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.chains.length).toBe(5);
    expect(result.current.transfers.length).toBe(2);
    expect(result.current.relayNodes.length).toBe(3);
  });

  it('chains have correct structure', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const chain = result.current.chains[0];
    expect(chain).toHaveProperty('chainId');
    expect(chain).toHaveProperty('name');
    expect(chain).toHaveProperty('symbol');
    expect(chain).toHaveProperty('rpcUrl');
    expect(chain).toHaveProperty('explorerUrl');
    expect(chain).toHaveProperty('status');
    expect(chain).toHaveProperty('avgBlockTime');
    expect(chain).toHaveProperty('gasPrice');
    expect(chain).toHaveProperty('routerAddress');
    expect(chain).toHaveProperty('supportedTokens');
    expect(chain).toHaveProperty('logoPath');
  });

  it('includes Aethelred Mainnet chain', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const aethelred = result.current.chains.find((c) => c.chainId === 7001);
    expect(aethelred).toBeDefined();
    expect(aethelred?.name).toBe('Aethelred Mainnet');
    expect(aethelred?.status).toBe('Online');
  });

  it('includes a degraded chain (BNB)', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const bnb = result.current.chains.find((c) => c.chainId === 56);
    expect(bnb).toBeDefined();
    expect(bnb?.status).toBe('Degraded');
  });

  it('transfers have correct structure with steps', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const transfer = result.current.transfers[0];
    expect(transfer).toHaveProperty('id');
    expect(transfer).toHaveProperty('sourceChainId');
    expect(transfer).toHaveProperty('destChainId');
    expect(transfer).toHaveProperty('sender');
    expect(transfer).toHaveProperty('recipient');
    expect(transfer).toHaveProperty('status');
    expect(transfer).toHaveProperty('steps');
    expect(transfer.steps.length).toBeGreaterThan(0);
    expect(transfer.steps[0]).toHaveProperty('index');
    expect(transfer.steps[0]).toHaveProperty('description');
    expect(transfer.steps[0]).toHaveProperty('status');
  });

  it('relay nodes have correct structure', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const node = result.current.relayNodes[0];
    expect(node).toHaveProperty('id');
    expect(node).toHaveProperty('name');
    expect(node).toHaveProperty('operator');
    expect(node).toHaveProperty('supportedChains');
    expect(node).toHaveProperty('status');
    expect(node).toHaveProperty('totalRelayed');
    expect(node).toHaveProperty('successRate');
    expect(node).toHaveProperty('avgRelayTime');
    expect(node).toHaveProperty('stakedCollateral');
    expect(node).toHaveProperty('uptime');
  });

  it('getRouteOptions returns routes for valid chain pair', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const routes = result.current.getRouteOptions(1, 7001, 100_000);
    expect(routes.length).toBe(2);
    expect(routes[0]).toHaveProperty('id');
    expect(routes[0]).toHaveProperty('name');
    expect(routes[0]).toHaveProperty('path');
    expect(routes[0]).toHaveProperty('estimatedTime');
    expect(routes[0]).toHaveProperty('totalFeeUsd');
    expect(routes[0]).toHaveProperty('fees');
    expect(routes[0]).toHaveProperty('slippage');
    expect(routes[0]).toHaveProperty('recommended');
  });

  it('getRouteOptions returns direct and multi-hop routes', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const routes = result.current.getRouteOptions(1, 137, 50_000);
    const direct = routes.find((r) => r.id === 'route-direct');
    const multihop = routes.find((r) => r.id === 'route-multihop');

    expect(direct).toBeDefined();
    expect(direct?.recommended).toBe(true);
    expect(direct?.path).toEqual([1, 137]);

    expect(multihop).toBeDefined();
    expect(multihop?.recommended).toBe(false);
    expect(multihop?.path).toEqual([1, 7001, 137]);
  });

  it('getRouteOptions returns empty array for invalid chain pair', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const routes = result.current.getRouteOptions(9999, 7001, 100_000);
    expect(routes).toEqual([]);
  });

  it('getRouteOptions returns empty array when chains not loaded', () => {
    const { result } = renderHook(() => useCrossChain());

    // Chains not loaded yet
    const routes = result.current.getRouteOptions(1, 7001, 100_000);
    expect(routes).toEqual([]);
  });

  it('initiateTransfer adds a new transfer', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.transfers.length;

    act(() => {
      result.current.initiateTransfer({
        sourceChainId: 1,
        destChainId: 7001,
        recipient: '0xrecipient',
        tokenSymbol: 'USDC',
        amount: 10_000,
        routeId: 'route-direct',
      });
    });

    expect(result.current.transfers.length).toBe(initialCount + 1);
    const newTransfer = result.current.transfers[0]; // prepended
    expect(newTransfer.status).toBe('Initiated');
    expect(newTransfer.sourceChainId).toBe(1);
    expect(newTransfer.destChainId).toBe(7001);
    expect(newTransfer.amount).toBe(10_000);
    expect(newTransfer.tokenSymbol).toBe('USDC');
    expect(newTransfer.steps.length).toBe(3);
    expect(newTransfer.sourceChainName).toBe('Ethereum');
    expect(newTransfer.destChainName).toBe('Aethelred Mainnet');
  });

  it('initiateTransfer does nothing for invalid source chain', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.transfers.length;

    act(() => {
      result.current.initiateTransfer({
        sourceChainId: 9999,
        destChainId: 7001,
        recipient: '0xrecipient',
        tokenSymbol: 'USDC',
        amount: 10_000,
        routeId: 'route-direct',
      });
    });

    expect(result.current.transfers.length).toBe(initialCount);
  });

  it('initiateTransfer does nothing for invalid dest chain', () => {
    const { result } = renderHook(() => useCrossChain());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.transfers.length;

    act(() => {
      result.current.initiateTransfer({
        sourceChainId: 1,
        destChainId: 9999,
        recipient: '0xrecipient',
        tokenSymbol: 'USDC',
        amount: 10_000,
        routeId: 'route-direct',
      });
    });

    expect(result.current.transfers.length).toBe(initialCount);
  });

  it('cleans up timer on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useCrossChain());

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
