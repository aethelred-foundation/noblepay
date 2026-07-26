/**
 * Wagmi Configuration for NoblePay
 *
 * Configures wallet connectors, transports, and chain setup
 * for the NoblePay dApp frontend.
 */

import { http, createConfig, createStorage } from "wagmi";
import { injected, walletConnect, coinbaseWallet } from "wagmi/connectors";
import type { EIP1193Provider } from "viem";
import { activeChain } from "./chains";
import { PUBLIC_SITE_URL } from "./site";
import { AETHELRED_CONNECTOR_ID } from "./wallet-picker";

// ---------------------------------------------------------------------------
// WalletConnect Project ID
// ---------------------------------------------------------------------------

const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

const connectors = [
  injected({
    shimDisconnect: true,
    target: {
      id: AETHELRED_CONNECTOR_ID,
      name: "Aethelred Wallet",
      provider: () => {
        if (typeof window === "undefined") return undefined;
        return (
          window as Window & {
            aethelred?: EIP1193Provider;
          }
        ).aethelred;
      },
    },
  }),
  injected({
    shimDisconnect: true,
  }),
  ...(WALLETCONNECT_PROJECT_ID
    ? [
        walletConnect({
          projectId: WALLETCONNECT_PROJECT_ID,
          metadata: {
            name: "NoblePay by Aethelred",
            description: "Compliant cross-border payments",
            url: PUBLIC_SITE_URL,
            icons: [`${PUBLIC_SITE_URL}/icon.png`],
          },
          showQrModal: true,
        }),
      ]
    : []),
  coinbaseWallet({
    appName: "NoblePay by Aethelred",
    appLogoUrl: `${PUBLIC_SITE_URL}/icon.png`,
  }),
];

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const transports = {
  [activeChain.id]: http(activeChain.rpcUrls.default.http[0]),
};

// ---------------------------------------------------------------------------
// Wagmi Config
// ---------------------------------------------------------------------------

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors,
  transports,
  // Use noopStorage on server to avoid hydration mismatches
  storage: createStorage({
    storage:
      typeof window !== "undefined"
        ? window.localStorage
        : {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
          },
    key: "noblepay-wallet",
  }),
  // Disable auto-connect on SSR
  ssr: true,
});

export { activeChain };
