const ADDRESS_ENV_VARS = [
  "NEXT_PUBLIC_NOBLEPAY_ADDRESS",
  "NEXT_PUBLIC_BUSINESS_REGISTRY_ADDRESS",
  "NEXT_PUBLIC_PAYMENT_CHANNELS_ADDRESS",
  "NEXT_PUBLIC_USDC_TOKEN_ADDRESS",
  "NEXT_PUBLIC_USDT_TOKEN_ADDRESS",
];

const PRODUCTION_PUBLIC_ENV_VARS = [
  "NEXT_PUBLIC_CHAIN_ENV",
  "NEXT_PUBLIC_AETHELRED_CHAIN_ID",
  "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK",
  "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH",
  "NEXT_PUBLIC_AETHELRED_RPC_URL",
  "NEXT_PUBLIC_AETHELRED_WS_URL",
  "NEXT_PUBLIC_AETHELRED_EXPLORER_URL",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_WS_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  "NEXT_PUBLIC_APP_VERSION",
  ...ADDRESS_ENV_VARS,
];

const WALLETCONNECT_CONNECT_ORIGINS = [
  "wss://relay.walletconnect.org",
  "https://relay.walletconnect.org",
  "https://rpc.walletconnect.org",
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://pulse.walletconnect.org",
  "https://echo.walletconnect.com",
  "https://api.web3modal.org",
];

const WALLET_FRAME_ORIGINS = [
  "https://verify.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://secure.walletconnect.org",
  "https://secure-mobile.walletconnect.org",
  "https://cca-lite.coinbase.com",
];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production builds`);
  return value;
}

function parsedFrontendURL(
  name,
  protocols,
  { allowCredentials = false, originOnly = false } = {},
) {
  const raw = requiredEnv(name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  if (
    (!allowCredentials && (parsed.username || parsed.password)) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must not contain credentials, query parameters, or fragments`,
    );
  }
  if (originOnly && parsed.pathname !== "/") {
    throw new Error(`${name} must be an origin without a path`);
  }
  return parsed;
}

function positiveSafeIntegerEnv(name) {
  const raw = requiredEnv(name);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return Number(raw);
}

function unsignedIntegerEnv(name) {
  const raw = requiredEnv(name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an unsigned integer`);
  }
  return raw;
}

function validateProductionEnvironment() {
  const chainEnvironment = requiredEnv("NEXT_PUBLIC_CHAIN_ENV");
  if (!["mainnet", "testnet", "devnet"].includes(chainEnvironment)) {
    throw new Error(
      "NEXT_PUBLIC_CHAIN_ENV must be mainnet, testnet, or devnet",
    );
  }

  for (const name of ADDRESS_ENV_VARS) {
    const value = requiredEnv(name);
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
      throw new Error(`${name} must be a nonzero EVM address`);
    }
  }

  const api = parsedFrontendURL("NEXT_PUBLIC_API_URL", ["https:"]);
  const websocket = parsedFrontendURL("NEXT_PUBLIC_WS_URL", ["wss:"]);
  const site = parsedFrontendURL("NEXT_PUBLIC_SITE_URL", ["https:"], {
    originOnly: true,
  });
  const chainId = positiveSafeIntegerEnv("NEXT_PUBLIC_AETHELRED_CHAIN_ID");
  const networkAnchorBlock = unsignedIntegerEnv(
    "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK",
  );
  const networkAnchorHash = requiredEnv(
    "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH",
  );
  if (!/^0x[0-9a-fA-F]{64}$/.test(networkAnchorHash)) {
    throw new Error(
      "NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH must be a 32-byte 0x-prefixed block hash",
    );
  }
  const chainRpc = parsedFrontendURL("NEXT_PUBLIC_AETHELRED_RPC_URL", [
    "https:",
  ]);
  const chainWebsocket = parsedFrontendURL("NEXT_PUBLIC_AETHELRED_WS_URL", [
    "wss:",
  ]);
  const chainExplorer = parsedFrontendURL(
    "NEXT_PUBLIC_AETHELRED_EXPLORER_URL",
    ["https:"],
  );

  const walletConnectProjectId = requiredEnv(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
  );
  if (!/^[0-9a-fA-F]{32}$/.test(walletConnectProjectId)) {
    throw new Error(
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID must be a 32-character hexadecimal project id",
    );
  }
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(
      requiredEnv("NEXT_PUBLIC_APP_VERSION"),
    )
  ) {
    throw new Error(
      "NEXT_PUBLIC_APP_VERSION has an invalid release identifier",
    );
  }

  const sentryRaw = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  const sentry = sentryRaw
    ? parsedFrontendURL("NEXT_PUBLIC_SENTRY_DSN", ["https:"], {
        allowCredentials: true,
      })
    : null;
  return {
    api,
    websocket,
    site,
    chainId,
    networkAnchorBlock,
    networkAnchorHash,
    chainRpc,
    chainWebsocket,
    chainExplorer,
    sentry,
  };
}

const missingProductionPublicEnv = PRODUCTION_PUBLIC_ENV_VARS.filter(
  (name) => !process.env[name]?.trim(),
);
const isUnconfiguredVercelPreview =
  process.env.VERCEL_ENV === "preview" &&
  missingProductionPublicEnv.length > 0;
const productionOrigins =
  process.env.NODE_ENV === "production" && !isUnconfiguredVercelPreview
    ? validateProductionEnvironment()
    : null;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  env: {
    NEXT_PUBLIC_NOBLEPAY_CONFIGURATION_STATE: isUnconfiguredVercelPreview
      ? "unconfigured-preview"
      : "configured",
  },

  images: {
    remotePatterns: [],
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },

  compress: true,

  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },

  typescript: {
    ignoreBuildErrors: false,
  },

  async headers() {
    const developmentScriptSource =
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
    const productionConnectSources = productionOrigins
      ? [
          productionOrigins.api.origin,
          productionOrigins.websocket.origin,
          productionOrigins.chainRpc.origin,
          productionOrigins.chainWebsocket.origin,
          "https://cca-lite.coinbase.com",
          "https://keys.coinbase.com",
          "https://rpc.wallet.coinbase.com",
          ...WALLETCONNECT_CONNECT_ORIGINS,
          ...(productionOrigins.sentry
            ? [productionOrigins.sentry.origin]
            : []),
        ]
      : process.env.NODE_ENV === "production"
        ? []
        : ["http:", "https:", "ws:", "wss:"];
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      `script-src 'self' 'unsafe-inline'${developmentScriptSource}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src ${[
        "'self'",
        ...new Set(productionConnectSources),
      ].join(" ")}`,
      `frame-src 'self' ${WALLET_FRAME_ORIGINS.join(" ")}`,
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ],
      },
    ];
  },

  webpack: (config, { isServer, dev }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        stream: false,
        buffer: false,
        fs: false,
        path: false,
        os: false,
      };

      config.resolve.alias = {
        ...config.resolve.alias,
        "@react-native-async-storage/async-storage": false,
      };

      const webpack = require("webpack");
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, "");
        }),
      );
    }

    config.optimization.splitChunks = {
      chunks: "all",
      cacheGroups: {
        default: false,
        vendors: false,
        vendor: {
          name: "vendor",
          chunks: "all",
          test: /node_modules/,
          priority: 20,
        },
        common: {
          name: "common",
          minChunks: 2,
          chunks: "all",
          priority: 10,
          reuseExistingChunk: true,
          enforce: true,
        },
        recharts: {
          name: "recharts",
          test: /[\\/]node_modules[\\/]recharts/,
          priority: 30,
        },
      },
    };

    if (!dev && !isServer) {
      config.optimization.minimize = true;
    }

    return config;
  },

  trailingSlash: false,
  poweredByHeader: false,
  generateEtags: true,
  distDir: ".next",
};

module.exports = nextConfig;
