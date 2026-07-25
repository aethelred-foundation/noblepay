/**
 * Aethelred chain configuration for NoblePay.
 *
 * Browser endpoints are operator-supplied. They are intentionally not
 * hardcoded because an endpoint name is not proof that a network is active,
 * and server RPC credentials must never be bundled into browser JavaScript.
 */

import { defineChain } from "viem";
import { resolveNetworkAnchor } from "@/lib/network-anchor";

export type AethelredChainEnvironment = "mainnet" | "testnet" | "devnet";

const LOCAL_CHAIN_ID = 7332;

const LOCAL_ENDPOINTS = {
  rpc: "http://127.0.0.1:8545",
  websocket: "ws://127.0.0.1:8546",
  explorer: "http://127.0.0.1:3000",
} as const;

export function resolveChainEnvironment(
  value = process.env.NEXT_PUBLIC_CHAIN_ENV,
): AethelredChainEnvironment {
  const environment = value?.trim() || "testnet";
  if (!["mainnet", "testnet", "devnet"].includes(environment)) {
    throw new Error(
      "NEXT_PUBLIC_CHAIN_ENV must be mainnet, testnet, or devnet",
    );
  }
  return environment as AethelredChainEnvironment;
}

export function resolveChainId(
  value = process.env.NEXT_PUBLIC_AETHELRED_CHAIN_ID,
  nodeEnv = process.env.NODE_ENV,
): number {
  const raw = value?.trim();
  if (!raw) {
    if (nodeEnv === "production") {
      throw new Error(
        "NEXT_PUBLIC_AETHELRED_CHAIN_ID is required for production builds",
      );
    }
    return LOCAL_CHAIN_ID;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(
      "NEXT_PUBLIC_AETHELRED_CHAIN_ID must be a positive integer",
    );
  }
  const chainId = Number(raw);
  if (!Number.isSafeInteger(chainId)) {
    throw new Error(
      "NEXT_PUBLIC_AETHELRED_CHAIN_ID must be a positive safe integer",
    );
  }
  return chainId;
}

export function resolvePublicChainUrl(
  name: string,
  value: string | undefined,
  productionProtocol: "https:" | "wss:",
  fallback: string,
  nodeEnv = process.env.NODE_ENV,
): string {
  const raw = value?.trim();
  if (!raw) {
    if (nodeEnv === "production") {
      throw new Error(`${name} is required for production builds`);
    }
    return fallback;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }

  const developmentProtocols =
    productionProtocol === "wss:" ? ["ws:", "wss:"] : ["http:", "https:"];
  if (!developmentProtocols.includes(url.protocol)) {
    throw new Error(`${name} must use ${developmentProtocols.join(" or ")}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${name} must not contain credentials, query parameters, or fragments`,
    );
  }
  if (nodeEnv === "production" && url.protocol !== productionProtocol) {
    throw new Error(
      `${name} must use ${productionProtocol.slice(0, -1)} in production`,
    );
  }

  return url.toString().replace(/\/$/, "");
}

const CHAIN_ENV = resolveChainEnvironment();
const CHAIN_ID = resolveChainId();
export const activeNetworkAnchor = resolveNetworkAnchor();
const AETHELRED_RPC_URL = resolvePublicChainUrl(
  "NEXT_PUBLIC_AETHELRED_RPC_URL",
  process.env.NEXT_PUBLIC_AETHELRED_RPC_URL,
  "https:",
  LOCAL_ENDPOINTS.rpc,
);
const AETHELRED_WS_URL = resolvePublicChainUrl(
  "NEXT_PUBLIC_AETHELRED_WS_URL",
  process.env.NEXT_PUBLIC_AETHELRED_WS_URL,
  "wss:",
  LOCAL_ENDPOINTS.websocket,
);
const AETHELRED_EXPLORER_URL = resolvePublicChainUrl(
  "NEXT_PUBLIC_AETHELRED_EXPLORER_URL",
  process.env.NEXT_PUBLIC_AETHELRED_EXPLORER_URL,
  "https:",
  LOCAL_ENDPOINTS.explorer,
);

const chainNames = {
  mainnet: "Aethelred",
  testnet: "Aethelred Testnet",
  devnet: "Aethelred Devnet",
} as const;

export const activeChain = defineChain({
  id: CHAIN_ID,
  name: chainNames[CHAIN_ENV],
  nativeCurrency: {
    name: "AETHEL",
    symbol: "AETHEL",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [AETHELRED_RPC_URL],
      webSocket: [AETHELRED_WS_URL],
    },
    public: {
      http: [AETHELRED_RPC_URL],
      webSocket: [AETHELRED_WS_URL],
    },
  },
  blockExplorers: {
    default: {
      name: "Aethelred Explorer",
      url: AETHELRED_EXPLORER_URL,
    },
  },
  testnet: CHAIN_ENV !== "mainnet",
});

// NoblePay supports one explicitly selected network per immutable build. This
// prevents wallets from being offered a chain whose endpoint was not verified
// by the operator for that release.
export const supportedChains = [activeChain] as const;

export const CONTRACT_ADDRESSES = {
  /** NoblePay core payment router contract */
  noblepay: process.env.NEXT_PUBLIC_NOBLEPAY_ADDRESS || "",
  /** Business identity and KYC registry */
  businessRegistry: process.env.NEXT_PUBLIC_BUSINESS_REGISTRY_ADDRESS || "",
  /** Bi-directional B2B payment channel contract */
  paymentChannels: process.env.NEXT_PUBLIC_PAYMENT_CHANNELS_ADDRESS || "",
  /** USDC stablecoin token */
  usdcToken: process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS || "",
  /** USDT stablecoin token */
  usdtToken: process.env.NEXT_PUBLIC_USDT_TOKEN_ADDRESS || "",
} as const;

/** Maps supported currency symbols to their configured token addresses. */
export const TOKEN_ADDRESS_KEYS: Record<
  string,
  keyof typeof CONTRACT_ADDRESSES
> = {
  USDC: "usdcToken",
  USDT: "usdtToken",
};
