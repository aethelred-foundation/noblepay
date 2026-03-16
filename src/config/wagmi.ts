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

const transports = {
  [aethelredMainnet.id]: http(),
  [aethelredTestnet.id]: http(),
  [aethelredDevnet.id]: http(),
};

// ---------------------------------------------------------------------------
// Wagmi Config
// ---------------------------------------------------------------------------

export const wagmiConfig = createConfig({
  chains: [aethelredMainnet, aethelredTestnet, aethelredDevnet],
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
