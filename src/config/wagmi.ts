/**
 * Wagmi Configuration for NoblePay
 *
 * Configures wallet connectors, transports, and chain setup
 * for the NoblePay dApp frontend.
 */

import { http, createConfig, createStorage } from 'wagmi';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';
import {
  aethelredMainnet,
  aethelredTestnet,
  aethelredDevnet,
  activeChain,
} from './chains';

// ---------------------------------------------------------------------------
// WalletConnect Project ID
// ---------------------------------------------------------------------------

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

const connectors = [
  injected({
    shimDisconnect: true,
  }),
  ...(WALLETCONNECT_PROJECT_ID
    ? [
        walletConnect({
          projectId: WALLETCONNECT_PROJECT_ID,
          metadata: {
            name: 'NoblePay by Aethelred',
            description: 'Compliant cross-border payments',
            url: 'https://noblepay.aethelred.network',
            icons: ['https://noblepay.aethelred.network/icon.png'],
          },
          showQrModal: true,
        }),
      ]
    : []),
  coinbaseWallet({
    appName: 'NoblePay by Aethelred',
    appLogoUrl: 'https://noblepay.aethelred.network/icon.png',
  }),
];

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// Testnet and devnet share the confirmed EVM chain id (7332, different
// endpoints), so one 7332 transport covers both; mainnet is the distinct id.
const transports = {
  [aethelredMainnet.id]: http(),
  [aethelredTestnet.id]: http(), // 7332 — also serves aethelredDevnet
};

// wagmi rejects duplicate chain ids in its chains tuple, so dedupe by id.
// Map keeps the LAST entry per key, so activeChain goes last: the surviving
// 7332 entry carries the RPC endpoints of the selected environment (testnet
// hosts vs. local devnet node).
const uniqueChains = Array.from(
  new Map(
    [aethelredMainnet, aethelredTestnet, aethelredDevnet, activeChain].map(
      (c) => [c.id, c] as const,
    ),
  ).values(),
);

// ---------------------------------------------------------------------------
// Wagmi Config
// ---------------------------------------------------------------------------

export const wagmiConfig = createConfig({
  chains: uniqueChains as unknown as readonly [
    typeof aethelredMainnet,
    ...(typeof aethelredMainnet)[],
  ],
  connectors,
  transports,
  // Use noopStorage on server to avoid hydration mismatches
  storage: createStorage({
    storage:
      typeof window !== 'undefined'
        ? window.localStorage
        : {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          },
    key: 'noblepay-wallet',
  }),
  // Disable auto-connect on SSR
  ssr: true,
});

export { activeChain };
