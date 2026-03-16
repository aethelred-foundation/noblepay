require('@testing-library/jest-dom');

// Mock next/router
jest.mock('next/router', () => ({
  useRouter: () => ({
    route: '/',
    pathname: '/',
    query: {},
    asPath: '/',
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
jest.mock('next/head', () => {
  const React = require('react');
  return function Head({ children }) {
    return React.createElement(React.Fragment, null, children);
  };
});

// Mock wagmi
jest.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
    isConnected: true,
    isDisconnected: false,
    status: 'connected',
  }),
  useConnect: () => ({
    connect: jest.fn(),
    connectors: [],
    isPending: false,
  }),
  useDisconnect: () => ({
    disconnect: jest.fn(),
  }),
  useWriteContract: () => ({
    writeContract: jest.fn(),
    data: undefined,
    isPending: false,
  }),
  useWaitForTransactionReceipt: () => ({
    isLoading: false,
    isSuccess: false,
  }),
  useReadContract: () => ({
    data: undefined,
    isLoading: false,
  }),
  useChainId: () => 1,
  useBalance: () => ({
    data: { formatted: '1.0', symbol: 'ETH' },
  }),
  WagmiProvider: ({ children }) => children,
  createConfig: jest.fn(),
  http: jest.fn(),
}));

// Mock @tanstack/react-query
jest.mock('@tanstack/react-query', () => ({
  QueryClientProvider: ({ children }) => children,
  QueryClient: jest.fn(() => ({
    invalidateQueries: jest.fn(),
  })),
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
  useMutation: (opts) => ({ mutate: jest.fn(), isPending: false }),
  useQueryClient: () => ({
    invalidateQueries: jest.fn(),
  }),
}));

// Mock recharts to avoid canvas issues in tests
jest.mock('recharts', () => {
  const React = require('react');
  const mock = (name) => {
    const Component = ({ children, ...props }) =>
      React.createElement('div', { 'data-testid': `mock-${name}`, ...props }, children);
    Component.displayName = name;
    return Component;
  };
  return {
    ResponsiveContainer: mock('ResponsiveContainer'),
    AreaChart: mock('AreaChart'),
    Area: mock('Area'),
    BarChart: mock('BarChart'),
    Bar: mock('Bar'),
    LineChart: mock('LineChart'),
    Line: mock('Line'),
    PieChart: mock('PieChart'),
    Pie: mock('Pie'),
    Cell: mock('Cell'),
    XAxis: mock('XAxis'),
    YAxis: mock('YAxis'),
    CartesianGrid: mock('CartesianGrid'),
    Tooltip: mock('Tooltip'),
    Legend: mock('Legend'),
    RadarChart: mock('RadarChart'),
    Radar: mock('Radar'),
    PolarGrid: mock('PolarGrid'),
    PolarAngleAxis: mock('PolarAngleAxis'),
    PolarRadiusAxis: mock('PolarRadiusAxis'),
  };
});

// Mock viem to avoid TextEncoder issues in jsdom
jest.mock('viem', () => ({
  parseEther: jest.fn(() => BigInt(0)),
  parseUnits: jest.fn(() => BigInt(0)),
  keccak256: jest.fn(() => '0x0000000000000000000000000000000000000000000000000000000000000000'),
  encodePacked: jest.fn(() => '0x'),
  defineChain: jest.fn((config) => config),
}));

// Mock config/chains to avoid viem import
jest.mock('@/config/chains', () => ({
  CONTRACT_ADDRESSES: {
    noblepay: '0x0000000000000000000000000000000000000001',
    complianceOracle: '0x0000000000000000000000000000000000000002',
    businessRegistry: '0x0000000000000000000000000000000000000003',
    travelRule: '0x0000000000000000000000000000000000000004',
    usdcToken: '0x0000000000000000000000000000000000000005',
    usdtToken: '0x0000000000000000000000000000000000000006',
    aethelToken: '0x0000000000000000000000000000000000000007',
  },
  AETHELRED_MAINNET_ID: 7331,
  AETHELRED_TESTNET_ID: 7332,
  AETHELRED_DEVNET_ID: 7333,
  aethelredMainnet: { id: 7331 },
  aethelredTestnet: { id: 7332 },
  aethelredDevnet: { id: 7333 },
  activeChain: { id: 7332 },
  supportedChains: [],
  TOKEN_ADDRESS_KEYS: { USDC: 'usdcToken', USDT: 'usdtToken', AET: 'aethelToken' },
}));

// Mock config/abis to avoid viem import
jest.mock('@/config/abis', () => ({
  NOBLEPAY_ABI: [],
  COMPLIANCE_ORACLE_ABI: [],
  BUSINESS_REGISTRY_ABI: [],
  TRAVEL_RULE_ABI: [],
}));

// Suppress console noise during tests
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Warning:')) return;
  originalError.call(console, ...args);
};
