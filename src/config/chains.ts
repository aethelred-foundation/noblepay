/**
 * Aethelred Chain Configuration for NoblePay
 *
 * Defines the Aethelred L1 chain for wagmi/viem integration.
 * Supports mainnet, testnet, and local development environments.
 */

import { defineChain } from 'viem';

// ---------------------------------------------------------------------------
// Chain IDs
// ---------------------------------------------------------------------------

// Canonical EVM chain IDs. 7332 is the CONFIRMED live Aethelred EVM EIP-155 id
// baked into the x/vm chain config (`eth_chainId` returns 0x1ca4) — the value
// wallets and dApps must use. Testnet and devnet are the SAME chain (7332)
// reached via different endpoints (hosted RPC vs a local
// `aethelredd start --json-rpc.enable` node) and deliberately share the id;
// mainnet keeps a distinct reserved id until a production network exists.
// (Source of truth: aethelred `ecosystem/manifest.json` → protocol.evm_chain_id.
// The prior 7333 devnet value was a never-deployed placeholder.)
export const AETHELRED_MAINNET_ID = 7331;
export const AETHELRED_TESTNET_ID = 7332;
export const AETHELRED_DEVNET_ID = 7332;

// ---------------------------------------------------------------------------
// Chain Definitions
// ---------------------------------------------------------------------------

// RPC endpoints are env-overridable because the canonical *.aethelred.network
// domains are not yet in DNS: without an override every request dies with
// net::ERR_NAME_NOT_RESOLVED. NEXT_PUBLIC_* values are inlined at BUILD time —
// set them before `npm run build`, not at `node server.js` time.
const MAINNET_RPC_HTTP =
  process.env.NEXT_PUBLIC_AETHELRED_RPC_URL || 'https://evm-rpc.aethelred.network';
const MAINNET_RPC_WS =
  process.env.NEXT_PUBLIC_AETHELRED_WS_URL || 'wss://evm-ws.aethelred.network';
const TESTNET_RPC_HTTP =
  process.env.NEXT_PUBLIC_AETHELRED_TESTNET_RPC_URL ||
  'https://evm-rpc-testnet.aethelred.network';
const TESTNET_RPC_WS =
  process.env.NEXT_PUBLIC_AETHELRED_TESTNET_WS_URL ||
  'wss://evm-ws-testnet.aethelred.network';

export const aethelredMainnet = defineChain({
  id: AETHELRED_MAINNET_ID,
  name: 'Aethelred',
  nativeCurrency: {
    name: 'AETHEL',
    symbol: 'AETHEL',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [MAINNET_RPC_HTTP],
      webSocket: [MAINNET_RPC_WS],
    },
    public: {
      http: [MAINNET_RPC_HTTP],
      webSocket: [MAINNET_RPC_WS],
    },
  },
  blockExplorers: {
    default: {
      name: 'Aethelred Explorer',
      url: 'https://explorer.aethelred.network',
    },
  },
  contracts: {
    // NoblePay contract addresses (populated after deployment)
    // multicall3 address if deployed
  },
});

export const aethelredTestnet = defineChain({
  id: AETHELRED_TESTNET_ID,
  name: 'Aethelred Testnet',
  nativeCurrency: {
    name: 'AETHEL',
    symbol: 'AETHEL',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [TESTNET_RPC_HTTP],
      webSocket: [TESTNET_RPC_WS],
    },
    public: {
      http: [TESTNET_RPC_HTTP],
      webSocket: [TESTNET_RPC_WS],
    },
  },
  blockExplorers: {
    default: {
      name: 'Aethelred Testnet Explorer',
      url: 'https://explorer-testnet.aethelred.network',
    },
  },
  testnet: true,
});

export const aethelredDevnet = defineChain({
  id: AETHELRED_DEVNET_ID,
  name: 'Aethelred Devnet',
  nativeCurrency: {
    name: 'AETHEL',
    symbol: 'AETHEL',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      // 127.0.0.1 (not "localhost") avoids IPv6/hosts-file resolution surprises.
      http: [process.env.NEXT_PUBLIC_AETHELRED_DEVNET_RPC_URL || 'http://127.0.0.1:8545'],
      webSocket: ['ws://127.0.0.1:8546'],
    },
    public: {
      http: [process.env.NEXT_PUBLIC_AETHELRED_DEVNET_RPC_URL || 'http://127.0.0.1:8545'],
      webSocket: ['ws://127.0.0.1:8546'],
    },
  },
  testnet: true,
});

// ---------------------------------------------------------------------------
// Active Chain Selection
// ---------------------------------------------------------------------------

const CHAIN_ENV = process.env.NEXT_PUBLIC_CHAIN_ENV || 'testnet';

export const activeChain =
  CHAIN_ENV === 'mainnet'
    ? aethelredMainnet
    : CHAIN_ENV === 'devnet'
      ? aethelredDevnet
      : aethelredTestnet;

export const supportedChains = [
  aethelredMainnet,
  aethelredTestnet,
  aethelredDevnet,
] as const;

// ---------------------------------------------------------------------------
// Contract Addresses (populated per-environment)
// ---------------------------------------------------------------------------

export const CONTRACT_ADDRESSES = {
  /** NoblePay core payment router contract */
  noblepay: process.env.NEXT_PUBLIC_NOBLEPAY_ADDRESS || '',
  /** TEE-backed compliance oracle */
  complianceOracle: process.env.NEXT_PUBLIC_COMPLIANCE_ORACLE_ADDRESS || '',
  /** Business identity and KYC registry */
  businessRegistry: process.env.NEXT_PUBLIC_BUSINESS_REGISTRY_ADDRESS || '',
  /** FATF Travel Rule data submission contract */
  travelRule: process.env.NEXT_PUBLIC_TRAVEL_RULE_ADDRESS || '',
  /** USDC stablecoin token */
  usdcToken: process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS || '',
  /** USDT stablecoin token */
  usdtToken: process.env.NEXT_PUBLIC_USDT_TOKEN_ADDRESS || '',
  /** Native AETHEL token (ERC-20 wrapper) */
  aethelToken: process.env.NEXT_PUBLIC_AETHEL_TOKEN_ADDRESS || '',
} as const;

/**
 * Maps currency symbols to their token address keys in CONTRACT_ADDRESSES.
 * Used by AppContext and hooks to look up the correct address at runtime.
 */
export const TOKEN_ADDRESS_KEYS: Record<string, keyof typeof CONTRACT_ADDRESSES> = {
  USDC: 'usdcToken',
  USDT: 'usdtToken',
  AETHEL: 'aethelToken',
};
