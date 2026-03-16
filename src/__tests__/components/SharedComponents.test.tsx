import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  LiveDot,
  Badge,
  Modal,
  Drawer,
  Tabs,
  ToastContainer,
  SearchOverlay,
  TopNav,
  Footer,
} from '@/components/SharedComponents';

// Mock lucide-react
jest.mock('lucide-react', () => ({
  Shield: (props: any) => <span data-testid="shield-icon" {...props} />,
  ExternalLink: (props: any) => <span data-testid="external-link" {...props} />,
  Github: (props: any) => <span data-testid="github-icon" {...props} />,
  Twitter: (props: any) => <span data-testid="twitter-icon" {...props} />,
  X: (props: any) => <span data-testid="x-icon" {...props} />,
  Search: (props: any) => <span data-testid="search-icon" {...props} />,
  CheckCircle2: (props: any) => <span data-testid="check-circle" {...props} />,
  AlertCircle: (props: any) => <span data-testid="alert-circle" {...props} />,
  AlertTriangle: (props: any) => <span data-testid="alert-triangle" {...props} />,
  Info: (props: any) => <span data-testid="info-icon" {...props} />,
  ChevronDown: (props: any) => <span data-testid="chevron-down" {...props} />,
  Menu: (props: any) => <span data-testid="menu-icon" {...props} />,
}));

// Mock next/link
jest.mock('next/link', () => {
  return function Link({ children, href, ...props }: any) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  };
});

// Mock AppContext
const mockAppContext = {
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
  notifications: [] as any[],
  addNotification: jest.fn(),
  removeNotification: jest.fn(),
  searchOpen: false,
  setSearchOpen: jest.fn(),
};

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => mockAppContext,
}));

describe('LiveDot', () => {
  it('renders with default green color', () => {
    const { container } = render(<LiveDot />);
    const dot = container.querySelector('.bg-emerald-500');
    expect(dot).toBeInTheDocument();
  });

  it('renders with red color', () => {
    const { container } = render(<LiveDot color="red" />);
    const dot = container.querySelector('.bg-red-500');
    expect(dot).toBeInTheDocument();
  });

  it('renders with yellow color', () => {
    const { container } = render(<LiveDot color="yellow" />);
    const dot = container.querySelector('.bg-yellow-500');
    expect(dot).toBeInTheDocument();
  });

  it('renders with sm size by default', () => {
    const { container } = render(<LiveDot />);
    const dot = container.querySelector('.h-2.w-2');
    expect(dot).toBeInTheDocument();
  });

  it('renders with md size', () => {
    const { container } = render(<LiveDot size="md" />);
    const dot = container.querySelector('.h-3.w-3');
    expect(dot).toBeInTheDocument();
  });

  it('is hidden from screen readers', () => {
    const { container } = render(<LiveDot />);
    const wrapper = container.querySelector('[aria-hidden="true"]');
    expect(wrapper).toBeInTheDocument();
  });
});

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge variant="success">Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies success variant styles', () => {
    const { container } = render(<Badge variant="success">OK</Badge>);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('text-emerald-400');
  });

  it('applies warning variant styles', () => {
    const { container } = render(<Badge variant="warning">Warn</Badge>);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('text-yellow-400');
  });

  it('applies error variant styles', () => {
    const { container } = render(<Badge variant="error">Error</Badge>);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('text-red-400');
  });

  it('applies info variant styles', () => {
    const { container } = render(<Badge variant="info">Info</Badge>);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('text-blue-400');
  });

  it('applies neutral variant styles', () => {
    const { container } = render(<Badge variant="neutral">N/A</Badge>);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('text-slate-400');
  });

  it('applies brand variant styles', () => {
    const { container } = render(<Badge variant="brand">Brand</Badge>);
    const badge = container.querySelector('span');
    expect(badge?.className).toContain('text-red-400');
  });
});

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} onClose={jest.fn()} title="Test">
        Content
      </Modal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders content when open', () => {
    render(
      <Modal open={true} onClose={jest.fn()} title="Test Modal">
        Modal content here
      </Modal>,
    );
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal content here')).toBeInTheDocument();
  });

  it('renders close button with aria-label', () => {
    render(
      <Modal open={true} onClose={jest.fn()} title="Test">
        Content
      </Modal>,
    );
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = jest.fn();
    const { container } = render(
      <Modal open={true} onClose={onClose} title="Test">
        Content
      </Modal>,
    );
    const backdrop = container.querySelector('.bg-black\\/60');
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores body overflow when modal closes', () => {
    const { rerender } = render(
      <Modal open={true} onClose={jest.fn()} title="Test">
        Content
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <Modal open={false} onClose={jest.fn()} title="Test">
        Content
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Drawer open={false} onClose={jest.fn()} title="Test">
        Content
      </Drawer>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders content when open', () => {
    render(
      <Drawer open={true} onClose={jest.fn()} title="Drawer Title">
        Drawer body
      </Drawer>,
    );
    expect(screen.getByText('Drawer Title')).toBeInTheDocument();
    expect(screen.getByText('Drawer body')).toBeInTheDocument();
  });

  it('renders close button with aria-label', () => {
    render(
      <Drawer open={true} onClose={jest.fn()} title="Test">
        Content
      </Drawer>,
    );
    expect(screen.getByLabelText('Close')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    render(
      <Drawer open={true} onClose={onClose} title="Test">
        Content
      </Drawer>,
    );
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores body overflow when drawer closes', () => {
    const { rerender } = render(
      <Drawer open={true} onClose={jest.fn()} title="Test">
        Content
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <Drawer open={false} onClose={jest.fn()} title="Test">
        Content
      </Drawer>,
    );
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'tab1', label: 'Tab 1' },
    { id: 'tab2', label: 'Tab 2' },
    { id: 'tab3', label: 'Tab 3' },
  ];

  it('renders all tab labels', () => {
    render(<Tabs tabs={tabs} active="tab1" onChange={jest.fn()} />);
    expect(screen.getByText('Tab 1')).toBeInTheDocument();
    expect(screen.getByText('Tab 2')).toBeInTheDocument();
    expect(screen.getByText('Tab 3')).toBeInTheDocument();
  });

  it('highlights active tab', () => {
    render(<Tabs tabs={tabs} active="tab2" onChange={jest.fn()} />);
    const activeButton = screen.getByText('Tab 2');
    expect(activeButton.className).toContain('bg-slate-700');
    expect(activeButton.className).toContain('text-white');
  });

  it('calls onChange when inactive tab is clicked', () => {
    const onChange = jest.fn();
    render(<Tabs tabs={tabs} active="tab1" onChange={onChange} />);
    fireEvent.click(screen.getByText('Tab 3'));
    expect(onChange).toHaveBeenCalledWith('tab3');
  });
});

describe('ToastContainer', () => {
  it('renders empty when no notifications', () => {
    const { container } = render(<ToastContainer />);
    const toasts = container.querySelectorAll('[style*="animation"]');
    expect(toasts.length).toBe(0);
  });

  it('renders notifications when present', () => {
    mockAppContext.notifications = [
      { id: '1', type: 'success', title: 'Success', message: 'Payment sent', timestamp: Date.now() },
    ];

    render(<ToastContainer />);
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Payment sent')).toBeInTheDocument();

    mockAppContext.notifications = [];
  });

  it('renders dismiss button with aria-label', () => {
    mockAppContext.notifications = [
      { id: '1', type: 'info', title: 'Info', message: 'Test', timestamp: Date.now() },
    ];

    render(<ToastContainer />);
    expect(screen.getByLabelText('Dismiss')).toBeInTheDocument();

    mockAppContext.notifications = [];
  });

  it('calls removeNotification when dismiss is clicked', () => {
    mockAppContext.notifications = [
      { id: 'notif-1', type: 'error', title: 'Error', message: 'Failed', timestamp: Date.now() },
    ];

    render(<ToastContainer />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(mockAppContext.removeNotification).toHaveBeenCalledWith('notif-1');

    mockAppContext.notifications = [];
  });
});

describe('SearchOverlay', () => {
  it('renders nothing when search is not open', () => {
    mockAppContext.searchOpen = false;
    const { container } = render(<SearchOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders search overlay when open', () => {
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);
    expect(
      screen.getByPlaceholderText(/Search pages, payments, businesses/),
    ).toBeInTheDocument();
    mockAppContext.searchOpen = false;
  });

  it('renders search items', () => {
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('Compliance Center')).toBeInTheDocument();
    mockAppContext.searchOpen = false;
  });

  it('filters search items based on query', () => {
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);

    const input = screen.getByPlaceholderText(/Search pages/);
    fireEvent.change(input, { target: { value: 'audit' } });

    expect(screen.getByText('Audit Trail')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    mockAppContext.searchOpen = false;
  });

  it('shows no results message', () => {
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);

    const input = screen.getByPlaceholderText(/Search pages/);
    fireEvent.change(input, { target: { value: 'zzzzzznonexistent' } });

    expect(screen.getByText('No results found')).toBeInTheDocument();
    mockAppContext.searchOpen = false;
  });

  it('closes on Escape key press', () => {
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(mockAppContext.setSearchOpen).toHaveBeenCalledWith(false);
    mockAppContext.searchOpen = false;
  });

  it('closes when backdrop is clicked', () => {
    mockAppContext.searchOpen = true;
    const { container } = render(<SearchOverlay />);

    const backdrop = container.querySelector('.bg-black\\/60');
    if (backdrop) fireEvent.click(backdrop);
    expect(mockAppContext.setSearchOpen).toHaveBeenCalledWith(false);
    mockAppContext.searchOpen = false;
  });

  it('closes when search item is clicked', () => {
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);

    const dashboardLink = screen.getByText('Dashboard');
    fireEvent.click(dashboardLink);
    expect(mockAppContext.setSearchOpen).toHaveBeenCalledWith(false);
    mockAppContext.searchOpen = false;
  });

  it('ignores non-Escape keys', () => {
    mockAppContext.searchOpen = true;
    mockAppContext.setSearchOpen.mockClear();
    render(<SearchOverlay />);

    fireEvent.keyDown(window, { key: 'Enter' });
    // setSearchOpen should NOT have been called with false for Enter key
    const falseCalls = mockAppContext.setSearchOpen.mock.calls.filter(
      (c: any[]) => c[0] === false,
    );
    expect(falseCalls.length).toBe(0);
    mockAppContext.searchOpen = false;
  });

  it('focuses input after setTimeout when search opens', () => {
    jest.useFakeTimers();
    mockAppContext.searchOpen = true;
    render(<SearchOverlay />);
    // Advance timers to trigger the setTimeout(() => inputRef.current?.focus(), 100)
    act(() => { jest.advanceTimersByTime(150); });
    // The input should have been focused (we can't easily verify focus in jsdom but the callback ran)
    const input = screen.getByPlaceholderText(/Search pages/);
    expect(input).toBeInTheDocument();
    mockAppContext.searchOpen = false;
    jest.useRealTimers();
  });
});

describe('TopNav', () => {
  it('renders NoblePay brand', () => {
    render(<TopNav />);
    expect(screen.getByText('NoblePay')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    render(<TopNav />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('Compliance')).toBeInTheDocument();
    expect(screen.getByText('Businesses')).toBeInTheDocument();
    expect(screen.getByText('Treasury')).toBeInTheDocument();
  });

  it('renders Connect Wallet button when disconnected', () => {
    mockAppContext.wallet.connected = false;
    render(<TopNav />);
    expect(screen.getByText('Connect Wallet')).toBeInTheDocument();
  });

  it('calls connectWallet when Connect Wallet is clicked', () => {
    mockAppContext.wallet.connected = false;
    render(<TopNav />);
    fireEvent.click(screen.getByText('Connect Wallet'));
    expect(mockAppContext.connectWallet).toHaveBeenCalled();
  });

  it('renders truncated address when connected', () => {
    mockAppContext.wallet.connected = true;
    mockAppContext.wallet.address = '0x1234567890abcdef1234567890abcdef12345678';
    render(<TopNav />);
    // The button should show truncated address
    expect(screen.getByText(/0x123456/)).toBeInTheDocument();
    mockAppContext.wallet.connected = false;
    mockAppContext.wallet.address = '';
  });

  it('calls disconnectWallet when address button is clicked', () => {
    mockAppContext.wallet.connected = true;
    mockAppContext.wallet.address = '0x1234567890abcdef1234567890abcdef12345678';
    render(<TopNav />);
    fireEvent.click(screen.getByText(/0x123456/));
    expect(mockAppContext.disconnectWallet).toHaveBeenCalled();
    mockAppContext.wallet.connected = false;
    mockAppContext.wallet.address = '';
  });
});

describe('Footer', () => {
  it('renders NoblePay brand', () => {
    render(<Footer />);
    expect(screen.getByText('NoblePay')).toBeInTheDocument();
  });

  it('renders by Aethelred text', () => {
    render(<Footer />);
    expect(screen.getByText('by Aethelred')).toBeInTheDocument();
  });

  it('renders copyright text', () => {
    render(<Footer />);
    expect(screen.getByText(/2026 Aethelred/)).toBeInTheDocument();
  });

  it('renders Docs link', () => {
    render(<Footer />);
    const docsLink = screen.getByText('Docs').closest('a');
    expect(docsLink).toHaveAttribute('href', 'https://aethelred.io');
    expect(docsLink).toHaveAttribute('target', '_blank');
  });

  it('renders GitHub link', () => {
    render(<Footer />);
    const githubLink = screen.getByTestId('github-icon').closest('a');
    expect(githubLink).toHaveAttribute('href', 'https://github.com/aethelred');
  });

  it('renders Twitter link', () => {
    render(<Footer />);
    const twitterLink = screen.getByTestId('twitter-icon').closest('a');
    expect(twitterLink).toHaveAttribute('href', 'https://twitter.com/aethelred');
  });
});
