import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { WalletButton } from '@/components/WalletButton';

// Mock lucide-react (not used directly, but may be imported transitively)
jest.mock('lucide-react', () => ({}));

// Mock utils
jest.mock('@/lib/utils', () => ({
  truncateAddress: (addr: string, start: number, end: number) =>
    `${addr.slice(0, start)}...${addr.slice(-end)}`,
  formatNumber: (n: number, d: number) => n.toFixed(d),
  formatCurrency: (amount: number, currency: string) => `${amount} ${currency}`,
}));

// Mock wagmi config
jest.mock('@/config/wagmi', () => ({
  activeChain: { id: 7332, name: 'Aethelred Testnet' },
}));

// Shared mock state for AppContext
const mockAppState = {
  wallet: {
    connected: false,
    address: '',
    balance: 0,
    usdcBalance: 0,
    usdtBalance: 0,
    isConnecting: false,
    isWrongNetwork: false,
    chainId: 0,
  },
  connectWallet: jest.fn(),
  disconnectWallet: jest.fn(),
  switchNetwork: jest.fn(),
  realTime: { blockHeight: 0, tps: 0, gasPrice: 0, epoch: 0, networkLoad: 0, aethelPrice: 0, lastBlockTime: 0 },
  payments: { activePayments: 0, pendingScreening: 0, flaggedCount: 0, dailyVolume: 0 },
  compliance: { sanctionsListVersion: '', lastUpdated: 0, passRate: 0, avgScreeningTime: 0 },
  notifications: [],
  addNotification: jest.fn(),
  removeNotification: jest.fn(),
  searchOpen: false,
  setSearchOpen: jest.fn(),
};

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => mockAppState,
}));

// Override wagmi mock to support multiple connectors
let mockConnectors = [{ id: 'injected', uid: 'inj-1', name: 'MetaMask' }] as any[];

jest.mock('wagmi', () => ({
  useAccount: () => ({
    address: '0x1234567890abcdef1234567890abcdef12345678',
    isConnected: true,
    isDisconnected: false,
    status: 'connected',
  }),
  useConnect: () => ({
    connect: jest.fn(),
    connectors: mockConnectors,
    isPending: false,
  }),
  useDisconnect: () => ({ disconnect: jest.fn() }),
  useWriteContract: () => ({ writeContract: jest.fn(), data: undefined, isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
  useReadContract: () => ({ data: undefined, isLoading: false }),
  useChainId: () => 1,
  useBalance: () => ({ data: { formatted: '1.0', symbol: 'ETH' } }),
  WagmiProvider: ({ children }: any) => children,
  createConfig: jest.fn(),
  http: jest.fn(),
}));

describe('WalletButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectors = [{ id: 'injected', uid: 'inj-1', name: 'MetaMask' }];
    mockAppState.wallet = {
      connected: false,
      address: '',
      balance: 0,
      usdcBalance: 0,
      usdtBalance: 0,
      isConnecting: false,
      isWrongNetwork: false,
      chainId: 0,
    };
  });

  describe('Disconnected state', () => {
    it('renders CONNECT WALLET button', () => {
      render(<WalletButton />);
      expect(screen.getByText('CONNECT WALLET')).toBeInTheDocument();
    });

    it('calls connectWallet when clicked with single connector', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('CONNECT WALLET'));
      expect(mockAppState.connectWallet).toHaveBeenCalled();
    });
  });

  describe('Connecting state', () => {
    it('renders Connecting... text and is disabled', () => {
      mockAppState.wallet.isConnecting = true;
      render(<WalletButton />);
      const button = screen.getByText('Connecting...');
      expect(button).toBeInTheDocument();
      expect(button.closest('button')).toBeDisabled();
    });
  });

  describe('Wrong network state', () => {
    it('renders Switch to network button', () => {
      mockAppState.wallet.isWrongNetwork = true;
      mockAppState.wallet.connected = true;
      render(<WalletButton />);
      expect(screen.getByText(/Switch to Aethelred Testnet/)).toBeInTheDocument();
    });

    it('calls switchNetwork when clicked', () => {
      mockAppState.wallet.isWrongNetwork = true;
      mockAppState.wallet.connected = true;
      render(<WalletButton />);
      fireEvent.click(screen.getByText(/Switch to Aethelred Testnet/));
      expect(mockAppState.switchNetwork).toHaveBeenCalled();
    });
  });

  describe('Connected state', () => {
    beforeEach(() => {
      mockAppState.wallet = {
        connected: true,
        address: '0x1234567890abcdef1234567890abcdef12345678',
        balance: 100.5,
        usdcBalance: 5000,
        usdtBalance: 2500,
        isConnecting: false,
        isWrongNetwork: false,
        chainId: 7332,
      };
    });

    it('renders truncated address', () => {
      render(<WalletButton />);
      // truncateAddress with (6, 4) => "0x1234...5678"
      expect(screen.getByText('0x1234...5678')).toBeInTheDocument();
    });

    it('shows green dot indicator', () => {
      const { container } = render(<WalletButton />);
      const greenDot = container.querySelector('.bg-emerald-400');
      expect(greenDot).toBeInTheDocument();
    });

    it('toggles dropdown on click', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('0x1234...5678'));

      // Dropdown should show full address
      expect(screen.getByText('Connected Address')).toBeInTheDocument();
      expect(
        screen.getByText('0x1234567890abcdef1234567890abcdef12345678'),
      ).toBeInTheDocument();
    });

    it('shows balances in dropdown', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('0x1234...5678'));

      expect(screen.getByText('AETHEL')).toBeInTheDocument();
      expect(screen.getByText('USDC')).toBeInTheDocument();
      expect(screen.getByText('USDT')).toBeInTheDocument();
    });

    it('shows network name in dropdown', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('0x1234...5678'));

      expect(screen.getByText('Aethelred Testnet')).toBeInTheDocument();
    });

    it('shows Disconnect Wallet button in dropdown', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('0x1234...5678'));

      expect(screen.getByText('Disconnect Wallet')).toBeInTheDocument();
    });

    it('calls disconnectWallet when Disconnect is clicked', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('0x1234...5678'));
      fireEvent.click(screen.getByText('Disconnect Wallet'));

      expect(mockAppState.disconnectWallet).toHaveBeenCalled();
    });

    it('closes dropdown on outside click', () => {
      render(
        <div>
          <div data-testid="outside">Outside</div>
          <WalletButton />
        </div>,
      );

      // Open dropdown
      fireEvent.click(screen.getByText('0x1234...5678'));
      expect(screen.getByText('Connected Address')).toBeInTheDocument();

      // Click outside
      fireEvent.mouseDown(screen.getByTestId('outside'));

      expect(screen.queryByText('Connected Address')).not.toBeInTheDocument();
    });
  });

  describe('Disconnected state with multiple connectors', () => {
    beforeEach(() => {
      mockConnectors = [
        { id: 'injected', uid: 'inj-1', name: 'MetaMask' },
        { id: 'walletConnect', uid: 'wc-1', name: 'WalletConnect' },
      ];
    });

    it('shows connector modal when multiple connectors available', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('CONNECT WALLET'));

      expect(screen.getByText('Choose Wallet')).toBeInTheDocument();
      expect(screen.getByText('MetaMask')).toBeInTheDocument();
      expect(screen.getByText('WalletConnect')).toBeInTheDocument();
    });

    it('calls connectWallet when a connector is selected', () => {
      render(<WalletButton />);
      fireEvent.click(screen.getByText('CONNECT WALLET'));
      fireEvent.click(screen.getByText('MetaMask'));

      expect(mockAppState.connectWallet).toHaveBeenCalled();
    });

    it('closes connector modal on outside click', () => {
      render(
        <div>
          <div data-testid="outside">Outside</div>
          <WalletButton />
        </div>,
      );

      fireEvent.click(screen.getByText('CONNECT WALLET'));
      expect(screen.getByText('Choose Wallet')).toBeInTheDocument();

      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(screen.queryByText('Choose Wallet')).not.toBeInTheDocument();
    });

    it('toggles connector modal on repeated clicks', () => {
      render(<WalletButton />);

      fireEvent.click(screen.getByText('CONNECT WALLET'));
      expect(screen.getByText('Choose Wallet')).toBeInTheDocument();

      fireEvent.click(screen.getByText('CONNECT WALLET'));
      expect(screen.queryByText('Choose Wallet')).not.toBeInTheDocument();
    });
  });
});
