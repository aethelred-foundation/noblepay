require("@testing-library/jest-dom");

const { TextEncoder, TextDecoder } = require("util");
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock next/router
jest.mock("next/router", () => ({
  useRouter: () => ({
    route: "/",
    pathname: "/",
    query: {},
    asPath: "/",
    push: jest.fn(),
    replace: jest.fn(),
    reload: jest.fn(),
    back: jest.fn(),
    prefetch: jest.fn().mockResolvedValue(undefined),
    beforePopState: jest.fn(),
    events: {
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
    },
    isFallback: false,
    isLocaleDomain: false,
    isReady: true,
    isPreview: false,
  }),
}));

// Mock next/head
jest.mock("next/head", () => {
  const React = require("react");
  return function Head({ children }) {
    return React.createElement(React.Fragment, null, children);
  };
});

// Mock wagmi
jest.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0x1234567890abcdef1234567890abcdef12345678",
    isConnected: true,
    isDisconnected: false,
    status: "connected",
    connector: {
      getProvider: jest.fn().mockResolvedValue({
        request: jest.fn().mockResolvedValue({
          number: "0x1",
          hash: `0x${"ab".repeat(32)}`,
        }),
      }),
    },
  }),
  useConnect: () => ({
    connect: jest.fn(),
    connectors: [],
    isPending: false,
  }),
  useDisconnect: () => ({
    disconnect: jest.fn(),
  }),
  usePublicClient: () => undefined,
  useSignMessage: () => ({
    signMessageAsync: jest.fn(),
  }),
  useWriteContract: () => ({
    writeContract: jest.fn(),
    writeContractAsync: jest.fn(),
    data: undefined,
    isPending: false,
    isError: false,
    error: null,
    reset: jest.fn(),
  }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: false,
  }),
  useReadContract: () => ({
    data: undefined,
    isLoading: false,
    error: undefined,
    refetch: jest.fn(),
  }),
  useChainId: () => 1,
  useBalance: () => ({
    data: { formatted: "1.0", symbol: "ETH" },
  }),
  WagmiProvider: ({ children }) => children,
  createConfig: jest.fn(),
  http: jest.fn(),
}));

// Mock @tanstack/react-query
jest.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }) => children,
  QueryClient: jest.fn(() => ({
    invalidateQueries: jest.fn(),
    removeQueries: jest.fn(),
    setQueryData: jest.fn(),
  })),
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
  useMutation: () => ({
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
    isPending: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: jest.fn(),
  }),
  useQueryClient: () => ({
    invalidateQueries: jest.fn(),
    removeQueries: jest.fn(),
    setQueryData: jest.fn(),
  }),
}));

// Mock recharts to avoid canvas issues in tests
jest.mock("recharts", () => {
  const React = require("react");
  const mock = (name) => {
    const Component = ({ children, ...props }) =>
      React.createElement(
        "div",
        { "data-testid": `mock-${name}`, ...props },
        children,
      );
    Component.displayName = name;
    return Component;
  };
  return {
    ResponsiveContainer: mock("ResponsiveContainer"),
    AreaChart: mock("AreaChart"),
    Area: mock("Area"),
    BarChart: mock("BarChart"),
    Bar: mock("Bar"),
    LineChart: mock("LineChart"),
    Line: mock("Line"),
    PieChart: mock("PieChart"),
    Pie: mock("Pie"),
    Cell: mock("Cell"),
    XAxis: mock("XAxis"),
    YAxis: mock("YAxis"),
    CartesianGrid: mock("CartesianGrid"),
    Tooltip: mock("Tooltip"),
    Legend: mock("Legend"),
    RadarChart: mock("RadarChart"),
    Radar: mock("Radar"),
    PolarGrid: mock("PolarGrid"),
    PolarAngleAxis: mock("PolarAngleAxis"),
    PolarRadiusAxis: mock("PolarRadiusAxis"),
  };
});

// Mock viem to avoid TextEncoder issues in jsdom
jest.mock("viem", () => ({
  parseEther: jest.fn(() => BigInt(0)),
  parseUnits: jest.fn(() => BigInt(0)),
  isAddress: jest.fn((value) => /^0x[0-9a-fA-F]{40}$/.test(value)),
  getAddress: jest.fn((value) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("invalid address");
    return value;
  }),
  zeroAddress: "0x0000000000000000000000000000000000000000",
  keccak256: jest.fn(
    () => "0x0000000000000000000000000000000000000000000000000000000000000000",
  ),
  toHex: jest.fn(() => "0x"),
  encodePacked: jest.fn(() => "0x"),
  defineChain: jest.fn((config) => config),
}));

// Mock config/chains to avoid viem import
jest.mock("@/config/chains", () => ({
  CONTRACT_ADDRESSES: {
    noblepay: "0x0000000000000000000000000000000000000001",
    businessRegistry: "0x0000000000000000000000000000000000000003",
    paymentChannels: "0x0000000000000000000000000000000000000008",
    usdcToken: "0x0000000000000000000000000000000000000005",
    usdtToken: "0x0000000000000000000000000000000000000006",
  },
  activeChain: { id: 7332 },
  activeNetworkAnchor: {
    blockNumber: 1n,
    blockHash: `0x${"ab".repeat(32)}`,
  },
  supportedChains: [],
  TOKEN_ADDRESS_KEYS: { USDC: "usdcToken", USDT: "usdtToken" },
}));

// Mock config/abis to avoid viem import
jest.mock("@/config/abis", () => ({
  NOBLEPAY_ABI: [],
  BUSINESS_REGISTRY_ABI: [],
}));

// Suppress console noise during tests
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("Warning:")) return;
  originalError.call(console, ...args);
};
