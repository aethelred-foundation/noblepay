/**
 * Cross-Chain Hooks — Custom React hooks for NoblePay cross-chain operations.
 *
 * Provides typed hooks for cross-chain transfers, chain status,
 * relay node management, and routing.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  ChainInfo,
  CrossChainTransfer,
  RouteOption,
  RelayNode,
} from '@/types/crosschain';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_CHAINS: ChainInfo[] = [
  {
    chainId: 7001,
    name: 'Aethelred Mainnet',
    symbol: 'AETH',
    rpcUrl: 'https://rpc.aethelred.network',
    explorerUrl: 'https://explorer.aethelred.network',
    status: 'Online',
    avgBlockTime: 2.0,
    gasPrice: 0.5,
    routerAddress: '0xrouter001',
    supportedTokens: ['USDC', 'USDT', 'AET', 'AED'],
    logoPath: '/chains/aethelred.svg',
  },
  {
    chainId: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    status: 'Online',
    avgBlockTime: 12.0,
    gasPrice: 25,
    routerAddress: '0xrouter002',
    supportedTokens: ['USDC', 'USDT'],
    logoPath: '/chains/ethereum.svg',
  },
  {
    chainId: 137,
    name: 'Polygon',
    symbol: 'MATIC',
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    status: 'Online',
    avgBlockTime: 2.0,
    gasPrice: 30,
    routerAddress: '0xrouter003',
    supportedTokens: ['USDC', 'USDT'],
    logoPath: '/chains/polygon.svg',
  },
  {
    chainId: 42161,
    name: 'Arbitrum One',
    symbol: 'ARB',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    status: 'Online',
    avgBlockTime: 0.3,
    gasPrice: 0.1,
    routerAddress: '0xrouter004',
    supportedTokens: ['USDC', 'USDT'],
    logoPath: '/chains/arbitrum.svg',
  },
  {
    chainId: 56,
    name: 'BNB Chain',
    symbol: 'BNB',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    status: 'Degraded',
    avgBlockTime: 3.0,
    gasPrice: 3,
    routerAddress: '0xrouter005',
    supportedTokens: ['USDC', 'USDT'],
    logoPath: '/chains/bnb.svg',
  },
];

const MOCK_TRANSFERS: CrossChainTransfer[] = [
  {
    id: 'xfer-001',
    sourceChainId: 1,
    destChainId: 7001,
    sourceChainName: 'Ethereum',
    destChainName: 'Aethelred Mainnet',
    sender: '0x1234567890abcdef1234567890abcdef12345678',
    recipient: '0xabcdef1234567890abcdef1234567890abcdef12',
    tokenSymbol: 'USDC',
    amount: 100_000,
    status: 'Completed',
    steps: [
      { index: 0, description: 'Lock tokens on Ethereum', chainId: 1, status: 'Completed', txHash: '0xeth001', startedAt: Date.now() - 3600_000, completedAt: Date.now() - 3300_000 },
      { index: 1, description: 'Relay proof to Aethelred', chainId: 7001, status: 'Completed', txHash: '0xaeth001', startedAt: Date.now() - 3300_000, completedAt: Date.now() - 3000_000 },
      { index: 2, description: 'Mint tokens on Aethelred', chainId: 7001, status: 'Completed', txHash: '0xaeth002', startedAt: Date.now() - 3000_000, completedAt: Date.now() - 2700_000 },
    ],
    estimatedTime: 900,
    bridgeFee: 12.5,
    relayNodeId: 'relay-001',
    initiatedAt: Date.now() - 3600_000,
    completedAt: Date.now() - 2700_000,
  },
  {
    id: 'xfer-002',
    sourceChainId: 7001,
    destChainId: 137,
    sourceChainName: 'Aethelred Mainnet',
    destChainName: 'Polygon',
    sender: '0x1234567890abcdef1234567890abcdef12345678',
    recipient: '0x2345678901abcdef2345678901abcdef23456789',
    tokenSymbol: 'USDC',
    amount: 50_000,
    status: 'Relaying',
    steps: [
      { index: 0, description: 'Lock tokens on Aethelred', chainId: 7001, status: 'Completed', txHash: '0xaeth003', startedAt: Date.now() - 600_000, completedAt: Date.now() - 300_000 },
      { index: 1, description: 'Relay proof to Polygon', chainId: 137, status: 'InProgress', startedAt: Date.now() - 300_000 },
      { index: 2, description: 'Mint tokens on Polygon', chainId: 137, status: 'Pending' },
    ],
    estimatedTime: 600,
    bridgeFee: 5.0,
    relayNodeId: 'relay-002',
    initiatedAt: Date.now() - 600_000,
    completedAt: 0,
  },
];

const MOCK_RELAY_NODES: RelayNode[] = [
  {
    id: 'relay-001',
    name: 'Aethelred Relay Alpha',
    operator: '0xop001',
    supportedChains: [7001, 1, 137, 42161],
    status: 'Active',
    totalRelayed: 12_450,
    successRate: 99.8,
    avgRelayTime: 45,
    stakedCollateral: 500_000,
    uptime: 99.95,
    lastActiveAt: Date.now() - 30_000,
  },
  {
    id: 'relay-002',
    name: 'Gulf Bridge Node',
    operator: '0xop002',
    supportedChains: [7001, 1, 56],
    status: 'Active',
    totalRelayed: 8_320,
    successRate: 99.5,
    avgRelayTime: 52,
    stakedCollateral: 350_000,
    uptime: 99.8,
    lastActiveAt: Date.now() - 15_000,
  },
  {
    id: 'relay-003',
    name: 'Asia Pacific Relay',
    operator: '0xop003',
    supportedChains: [7001, 137, 56],
    status: 'Syncing',
    totalRelayed: 5_100,
    successRate: 99.2,
    avgRelayTime: 60,
    stakedCollateral: 250_000,
    uptime: 98.5,
    lastActiveAt: Date.now() - 120_000,
  },
];

// ---------------------------------------------------------------------------
// useCrossChain — transfers, chains, relay nodes, and routing
// ---------------------------------------------------------------------------

export function useCrossChain() {
  const [chains, setChains] = useState<ChainInfo[]>([]);
  const [transfers, setTransfers] = useState<CrossChainTransfer[]>([]);
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setChains(MOCK_CHAINS);
      setTransfers(MOCK_TRANSFERS);
      setRelayNodes(MOCK_RELAY_NODES);
      setIsLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const getRouteOptions = useCallback(
    (sourceChainId: number, destChainId: number, _amount: number): RouteOption[] => {
      const source = chains.find((c) => c.chainId === sourceChainId);
      const dest = chains.find((c) => c.chainId === destChainId);
      if (!source || !dest) return [];

      return [
        {
          id: 'route-direct',
          name: 'Direct Bridge',
          path: [sourceChainId, destChainId],
          estimatedTime: 600,
          totalFeeUsd: 12.5,
          fees: { bridgeFee: 8.0, gasFee: 3.5, relayFee: 1.0 },
          slippage: 0.05,
          recommended: true,
        },
        {
          id: 'route-multihop',
          name: 'Multi-Hop via Aethelred',
          path: [sourceChainId, 7001, destChainId],
          estimatedTime: 1200,
          totalFeeUsd: 8.0,
          fees: { bridgeFee: 4.0, gasFee: 2.5, relayFee: 1.5 },
          slippage: 0.1,
          recommended: false,
        },
      ];
    },
    [chains],
  );

  const initiateTransfer = useCallback(
    (params: {
      sourceChainId: number;
      destChainId: number;
      recipient: string;
      tokenSymbol: string;
      amount: number;
      routeId: string;
    }) => {
      const source = chains.find((c) => c.chainId === params.sourceChainId);
      const dest = chains.find((c) => c.chainId === params.destChainId);
      if (!source || !dest) return;

      const newTransfer: CrossChainTransfer = {
        id: `xfer-${String(Date.now()).slice(-6)}`,
        sourceChainId: params.sourceChainId,
        destChainId: params.destChainId,
        sourceChainName: source.name,
        destChainName: dest.name,
        sender: '0x1234567890abcdef1234567890abcdef12345678',
        recipient: params.recipient,
        tokenSymbol: params.tokenSymbol,
        amount: params.amount,
        status: 'Initiated',
        steps: [
          { index: 0, description: `Lock tokens on ${source.name}`, chainId: params.sourceChainId, status: 'InProgress', startedAt: Date.now() },
          { index: 1, description: `Relay proof to ${dest.name}`, chainId: params.destChainId, status: 'Pending' },
          { index: 2, description: `Mint tokens on ${dest.name}`, chainId: params.destChainId, status: 'Pending' },
        ],
        estimatedTime: 600,
        bridgeFee: 12.5,
        relayNodeId: 'relay-001',
        initiatedAt: Date.now(),
        completedAt: 0,
      };
      setTransfers((prev) => [newTransfer, ...prev]);
    },
    [chains],
  );

  return {
    chains,
    transfers,
    relayNodes,
    isLoading,
    getRouteOptions,
    initiateTransfer,
  };
}
