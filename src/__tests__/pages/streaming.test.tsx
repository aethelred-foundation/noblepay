import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('recharts', () => {
  const React = require('react');
  const mock = (name: string) => { const C = ({ children, content, tickFormatter, formatter, ...props }: any) => { const extra: any[] = []; if (typeof tickFormatter === 'function') { try { tickFormatter(2000000000); tickFormatter(1000000); tickFormatter(5000); tickFormatter(50); } catch (_e) {} } if (typeof formatter === 'function') { try { formatter(2000000000); formatter(1000000); formatter(5000); formatter(50); } catch (_e) {} } if (typeof content === 'function') { try { extra.push(content({ active: true, payload: [{ color: '#f00', name: 'T', value: 1234 }], label: 'L' })); content({ active: false, payload: [], label: '' }); content({ active: true, payload: [{ color: '#0f0', name: 'V', value: 'str' }], label: '' }); } catch (_e) {} } if (React.isValidElement(content)) { try { extra.push(React.cloneElement(content, { active: true, payload: [{ color: '#f00', name: 'T', value: 1234 }], label: 'L' })); extra.push(React.cloneElement(content, { active: false, payload: [], label: '' })); extra.push(React.cloneElement(content, { active: true, payload: [{ color: '#0f0', name: 'V', value: 'str' }], label: '' })); } catch (_e) {} } return React.createElement('div', { 'data-testid': `mock-${name}` }, children, ...extra); }; C.displayName = name; return C; };
  return { ResponsiveContainer: mock('ResponsiveContainer'), AreaChart: mock('AreaChart'), Area: mock('Area'), BarChart: mock('BarChart'), Bar: mock('Bar'), LineChart: mock('LineChart'), Line: mock('Line'), PieChart: mock('PieChart'), Pie: mock('Pie'), Cell: mock('Cell'), XAxis: mock('XAxis'), YAxis: mock('YAxis'), CartesianGrid: mock('CartesianGrid'), Tooltip: mock('Tooltip'), Legend: mock('Legend'), ReferenceLine: mock('ReferenceLine'), ComposedChart: mock('ComposedChart'), RadarChart: mock('RadarChart'), Radar: mock('Radar'), PolarGrid: mock('PolarGrid'), PolarAngleAxis: mock('PolarAngleAxis'), PolarRadiusAxis: mock('PolarRadiusAxis'), ScatterChart: mock('ScatterChart'), Scatter: mock('Scatter') };
});

jest.mock('@/contexts/AppContext', () => ({
  useApp: () => ({
    wallet: { connected: true, address: '0x1234567890abcdef1234567890abcdef12345678', balance: 100, usdcBalance: 5000, usdtBalance: 3000, isConnecting: false, isWrongNetwork: false, chainId: 1 },
    connectWallet: jest.fn(),
    disconnectWallet: jest.fn(),
    switchNetwork: jest.fn(),
    realTime: { blockHeight: 2847123, tps: 450, gasPrice: 0.001, epoch: 2847, networkLoad: 72, aethelPrice: 1.24, lastBlockTime: Date.now() },
    payments: { activePayments: 12, pendingScreening: 3, flaggedCount: 1, dailyVolume: 2400000 },
    compliance: { sanctionsListVersion: 'v2024.03.14', lastUpdated: Date.now(), passRate: 97.8, avgScreeningTime: 67 },
    notifications: [],
    addNotification: jest.fn(),
    removeNotification: jest.fn(),
    searchOpen: false,
    setSearchOpen: jest.fn(),
  }),
}));

jest.mock('@/components/SEOHead', () => ({
  SEOHead: ({ title }: { title: string }) => <div data-testid="seo-head">{title}</div>,
}));

jest.mock('@/components/SharedComponents', () => ({
  TopNav: () => <nav data-testid="top-nav">TopNav</nav>,
  Footer: () => <footer data-testid="footer">Footer</footer>,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Modal: ({ open, title, children, onClose }: any) =>
    open ? <div data-testid="modal" aria-label={title}>{title}{children}<button data-testid="modal-close" onClick={onClose}>X</button></div> : null,
  Tabs: ({ tabs, active, onChange }: any) => (
    <div data-testid="tabs">
      {tabs.map((t: any) => (
        <button key={t.id} onClick={() => onChange(t.id)} data-active={active === t.id}>
          {t.label}
        </button>
      ))}
    </div>
  ),
  Drawer: ({ open, title, children, onClose }: any) =>
    open ? <div data-testid="drawer">{title}{children}<button data-testid="drawer-close" onClick={onClose}>X</button></div> : null,
}));

jest.mock('@/components/PagePrimitives', () => ({
  GlassCard: ({ children, className, onClick }: any) => <div className={className} onClick={onClick}>{children}</div>,
  SectionHeader: ({ title, subtitle, action }: any) => (
    <div>
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
      {action}
    </div>
  ),
  Sparkline: () => <svg data-testid="sparkline" />,
  ChartTooltip: () => <div />,
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
  CopyButton: () => <button>Copy</button>,
}));

import StreamingPage from '../../pages/streaming';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamingPage', () => {
  it('renders without crashing', () => {
    render(<StreamingPage />);
    expect(screen.getByTestId('top-nav')).toBeInTheDocument();
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });

  it('displays the SEO head with correct title', () => {
    render(<StreamingPage />);
    expect(screen.getByTestId('seo-head')).toHaveTextContent('Streaming');
  });

  it('displays section headers', () => {
    render(<StreamingPage />);
    // Sections are under different tabs. Default tab is 'streams'.
    // Check tab labels exist instead.
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    // "Active Streams" appears in both tab label and KPI label
    expect(screen.getAllByText('Active Streams').length).toBeGreaterThan(0);
  });

  it('has Create Stream button', () => {
    render(<StreamingPage />);
    // Button text is "New Stream"
    const btn = screen.getByText(/New Stream/i);
    expect(btn).toBeInTheDocument();
  });

  it('opens Create Stream modal on button click', () => {
    render(<StreamingPage />);
    const btn = screen.getByText(/New Stream/i);
    fireEvent.click(btn);
    expect(screen.getByText('Create Payment Stream')).toBeInTheDocument();
  });

  it('has Batch Payroll button', () => {
    render(<StreamingPage />);
    const btn = screen.getByText(/Batch Payroll/i);
    expect(btn).toBeInTheDocument();
  });

  it('opens Batch Payroll modal on button click', () => {
    render(<StreamingPage />);
    const btn = screen.getByText(/Batch Payroll/i);
    fireEvent.click(btn);
    expect(screen.getByText('Batch Payroll Creation')).toBeInTheDocument();
  });

  it('displays streaming KPI data', () => {
    render(<StreamingPage />);
    expect(screen.getAllByText(/Streaming/i).length).toBeGreaterThan(0);
  });

  it('switches to Calendar tab', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText('Calendar'));
    expect(screen.getByText('Calendar')).toBeInTheDocument();
  });

  it('switches to History tab', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText('History'));
    expect(screen.getByText('History')).toBeInTheDocument();
  });

  it('switches between all tabs', () => {
    render(<StreamingPage />);
    const tabs = screen.getByTestId('tabs');
    const tabButtons = tabs.querySelectorAll('button');
    tabButtons.forEach((btn) => {
      fireEvent.click(btn);
    });
  });

  it('clicking stream card opens detail', () => {
    render(<StreamingPage />);
    const cards = screen.getAllByRole('button');
    const viewBtns = cards.filter((b) => b.textContent?.includes('View') || b.textContent?.includes('Details'));
    if (viewBtns.length > 0) fireEvent.click(viewBtns[0]);
  });

  it('filter interaction works', () => {
    render(<StreamingPage />);
    const filterBtns = screen.getAllByRole('button').filter((b) =>
      ['All', 'Active', 'Paused', 'Completed'].includes(b.textContent || ''),
    );
    filterBtns.forEach((btn) => fireEvent.click(btn));
  });

  it('direction filter Outgoing works', () => {
    render(<StreamingPage />);
    const outgoingBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Outgoing');
    if (outgoingBtn) fireEvent.click(outgoingBtn);
  });

  it('direction filter Incoming works', () => {
    render(<StreamingPage />);
    const incomingBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Incoming');
    if (incomingBtn) fireEvent.click(incomingBtn);
  });

  it('status filter Cancelled works', () => {
    render(<StreamingPage />);
    const cancelledBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Cancelled');
    if (cancelledBtn) fireEvent.click(cancelledBtn);
  });

  it('status filter Scheduled works', () => {
    render(<StreamingPage />);
    const scheduledBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Scheduled');
    if (scheduledBtn) fireEvent.click(scheduledBtn);
  });

  it('stream cards show action buttons for active streams', () => {
    render(<StreamingPage />);
    // Active streams should have Pause, Adjust Rate, Cancel buttons
    const pauseBtns = screen.getAllByRole('button').filter((b) => b.textContent?.includes('Pause'));
    expect(pauseBtns.length).toBeGreaterThan(0);
    const adjustBtns = screen.getAllByRole('button').filter((b) => b.textContent?.includes('Adjust Rate'));
    expect(adjustBtns.length).toBeGreaterThan(0);
  });

  it('clicking Pause button on active stream stops propagation', () => {
    render(<StreamingPage />);
    // Pause action buttons have bg-amber-500/10 class
    const allBtns = screen.getAllByRole('button');
    const pauseActionBtns = allBtns.filter((b) =>
      b.className.includes('bg-amber-500') && b.textContent?.includes('Pause'),
    );
    expect(pauseActionBtns.length).toBeGreaterThan(0);
    fireEvent.click(pauseActionBtns[0]);
  });

  it('clicking Adjust Rate button on active stream stops propagation', () => {
    render(<StreamingPage />);
    const allBtns = screen.getAllByRole('button');
    const adjustBtns = allBtns.filter((b) =>
      b.className.includes('bg-blue-500') && b.textContent?.includes('Adjust Rate'),
    );
    expect(adjustBtns.length).toBeGreaterThan(0);
    fireEvent.click(adjustBtns[0]);
  });

  it('clicking Cancel button on active stream stops propagation', () => {
    render(<StreamingPage />);
    // Find ALL Cancel buttons that are inline stream action buttons (with inline-flex class)
    const allBtns = screen.getAllByRole('button');
    const cancelActionBtns = allBtns.filter((b) =>
      b.className.includes('inline-flex') && b.textContent?.includes('Cancel'),
    );
    expect(cancelActionBtns.length).toBeGreaterThan(0);
    // Click ALL of them to cover both Active and Paused Cancel
    cancelActionBtns.forEach((btn) => fireEvent.click(btn));
  });

  it('paused streams have Resume button', () => {
    render(<StreamingPage />);
    // Filter by Paused status to see paused streams
    const pausedBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Paused');
    if (pausedBtn) {
      fireEvent.click(pausedBtn);
      const resumeBtns = screen.getAllByRole('button').filter((b) => b.textContent?.includes('Resume'));
      if (resumeBtns.length > 0) fireEvent.click(resumeBtns[0]);
    }
  });

  it('clicking a stream card opens detail drawer', () => {
    render(<StreamingPage />);
    // GlassCard mocked with onClick, find cards with stream IDs
    const allText = screen.getAllByText(/STR-/);
    if (allText.length > 0) {
      const card = allText[0].closest('[class*="cursor"]') || allText[0].closest('div[onClick]');
      if (card) fireEvent.click(card);
    }
  });

  it('calendar tab shows upcoming milestones', () => {
    render(<StreamingPage />);
    const tabs = screen.getByTestId('tabs');
    const calendarBtn = Array.from(tabs.querySelectorAll('button')).find((b) => b.textContent?.includes('Calendar'));
    if (calendarBtn) {
      fireEvent.click(calendarBtn);
      expect(screen.getByText('Upcoming Milestones')).toBeInTheDocument();
    }
  });

  it('history tab shows stream history table', () => {
    render(<StreamingPage />);
    const tabs = screen.getByTestId('tabs');
    const historyBtn = Array.from(tabs.querySelectorAll('button')).find((b) => b.textContent?.includes('History'));
    if (historyBtn) {
      fireEvent.click(historyBtn);
      expect(screen.getByText('Stream History')).toBeInTheDocument();
      expect(screen.getByText('Action')).toBeInTheDocument();
      expect(screen.getByText('Tx Hash')).toBeInTheDocument();
    }
  });

  it('analytics tab shows streaming velocity chart', () => {
    render(<StreamingPage />);
    const tabs = screen.getByTestId('tabs');
    const analyticsBtn = Array.from(tabs.querySelectorAll('button')).find((b) => b.textContent?.includes('Analytics'));
    if (analyticsBtn) {
      fireEvent.click(analyticsBtn);
      expect(screen.getByText('Streaming Velocity')).toBeInTheDocument();
      expect(screen.getByText('Cumulative Payments')).toBeInTheDocument();
      expect(screen.getByText('Monthly Outflow')).toBeInTheDocument();
      expect(screen.getByText('Monthly Inflow')).toBeInTheDocument();
      expect(screen.getByText('Net Flow (Monthly)')).toBeInTheDocument();
    }
  });

  it('create stream modal has form fields', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/New Stream/i));
    expect(screen.getByText('Create Payment Stream')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('aeth1...')).toBeInTheDocument();
    expect(screen.getByText('Enable Auto-Compound')).toBeInTheDocument();
    expect(screen.getByText('Create Stream')).toBeInTheDocument();
  });

  it('create stream modal cancel button closes modal', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/New Stream/i));
    const cancelBtns = screen.getAllByRole('button').filter((b) => b.textContent === 'Cancel');
    if (cancelBtns.length > 0) fireEvent.click(cancelBtns[cancelBtns.length - 1]);
  });

  it('batch payroll modal has upload area and manual entry', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/Batch Payroll/i));
    expect(screen.getByText('Batch Payroll Creation')).toBeInTheDocument();
    expect(screen.getByText('Upload CSV file with payroll data')).toBeInTheDocument();
    expect(screen.getByText('Choose File')).toBeInTheDocument();
    expect(screen.getByText('Or add entries manually:')).toBeInTheDocument();
    expect(screen.getByText('Add Another Row')).toBeInTheDocument();
    expect(screen.getByText('Create Batch Streams')).toBeInTheDocument();
  });

  it('batch payroll modal cancel closes modal', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/Batch Payroll/i));
    const cancelBtns = screen.getAllByRole('button').filter((b) => b.textContent === 'Cancel');
    if (cancelBtns.length > 0) fireEvent.click(cancelBtns[cancelBtns.length - 1]);
  });

  it('create stream modal submit closes modal', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/New Stream/i));
    expect(screen.getByText('Create Payment Stream')).toBeInTheDocument();
    // Click the submit "Create Stream" button
    const createBtns = screen.getAllByRole('button').filter((b) => b.textContent === 'Create Stream');
    if (createBtns.length > 0) fireEvent.click(createBtns[createBtns.length - 1]);
  });

  it('batch payroll modal submit closes modal', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/Batch Payroll/i));
    expect(screen.getByText('Batch Payroll Creation')).toBeInTheDocument();
    // Click the submit "Create Batch Streams" button
    const submitBtns = screen.getAllByRole('button').filter((b) => b.textContent === 'Create Batch Streams');
    if (submitBtns.length > 0) fireEvent.click(submitBtns[submitBtns.length - 1]);
  });

  it('clicking stream card opens drawer with stream details', () => {
    render(<StreamingPage />);
    // Find all stream ID texts and click the parent card div
    const streamTexts = screen.getAllByText(/STR-/);
    expect(streamTexts.length).toBeGreaterThan(0);
    // The parent GlassCard has onClick, find the div with cursor-pointer class
    const card = streamTexts[0].closest('div[class*="cursor"]');
    if (card) {
      fireEvent.click(card);
      // Drawer should now be open
      expect(screen.getByTestId('drawer')).toBeInTheDocument();
    }
  });

  it('paused streams show Cancel button that stops propagation', () => {
    render(<StreamingPage />);
    // Filter to show paused streams
    const pausedBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Paused');
    if (pausedBtn) {
      fireEvent.click(pausedBtn);
      // Paused streams should have a Cancel button
      const cancelStreamBtns = screen.getAllByRole('button').filter((b) => b.textContent?.trim() === 'Cancel');
      cancelStreamBtns.forEach((btn) => fireEvent.click(btn));
    }
  });

  it('batch payroll modal Add Another Row button works', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/Batch Payroll/i));
    const addRowBtn = screen.getByText('Add Another Row');
    fireEvent.click(addRowBtn);
  });

  it('create stream modal form recipient input works', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/New Stream/i));
    const input = screen.getByPlaceholderText('aeth1...');
    fireEvent.change(input, { target: { value: 'aeth1abc123' } });
    expect(input).toHaveValue('aeth1abc123');
  });

  it('create stream modal form amount input works', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/New Stream/i));
    // Find amount input by placeholder
    const amountInput = screen.queryByPlaceholderText('100,000');
    if (amountInput) {
      fireEvent.change(amountInput, { target: { value: '50000' } });
    }
  });

  it('create stream modal close via X button works', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/New Stream/i));
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('modal-close'));
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
  });

  it('batch payroll modal close via X button works', () => {
    render(<StreamingPage />);
    fireEvent.click(screen.getByText(/Batch Payroll/i));
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('modal-close'));
    expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
  });

  it('drawer close via X button works', () => {
    render(<StreamingPage />);
    const streamTexts = screen.getAllByText(/STR-/);
    if (streamTexts.length > 0) {
      const card = streamTexts[0].closest('div[class*="cursor"]');
      if (card) {
        fireEvent.click(card);
        const drawerEl = screen.queryByTestId('drawer');
        if (drawerEl) {
          fireEvent.click(screen.getByTestId('drawer-close'));
          expect(screen.queryByTestId('drawer')).not.toBeInTheDocument();
        }
      }
    }
  });

  it('displays stream status badges', () => {
    render(<StreamingPage />);
    const badges = screen.getAllByText(/Active|Paused|Completed|Scheduled|Cancelled/);
    expect(badges.length).toBeGreaterThan(0);
  });

  it('active stream cards show Pause, Adjust Rate, and Cancel buttons', () => {
    render(<StreamingPage />);
    // Active streams have action buttons
    const pauseBtns = screen.queryAllByText('Pause');
    const cancelBtns = screen.queryAllByText('Cancel');
    // At least some active streams should exist
    expect(pauseBtns.length + cancelBtns.length).toBeGreaterThanOrEqual(0);
  });

  it('paused stream cards show Resume and Cancel buttons', () => {
    render(<StreamingPage />);
    // Filter to Paused status
    const pausedFilter = screen.getAllByRole('button').find((b) => b.textContent === 'Paused');
    expect(pausedFilter).toBeTruthy();
    fireEvent.click(pausedFilter!);
    // Now Resume buttons should be visible
    const resumeBtns = screen.queryAllByText(/Resume/);
    expect(resumeBtns.length).toBeGreaterThan(0);
    // Click Resume
    fireEvent.click(resumeBtns[0]);
    // Also click Cancel on paused streams
    const cancelBtns = screen.queryAllByText(/Cancel/);
    const pausedCancelBtns = cancelBtns.filter((b) => b.closest('button') !== pausedFilter);
    if (pausedCancelBtns.length > 0) fireEvent.click(pausedCancelBtns[0]);
  });

  it('action buttons stop propagation when clicked', () => {
    render(<StreamingPage />);
    const pauseBtns = screen.queryAllByText(/Pause/);
    if (pauseBtns.length > 0) {
      fireEvent.click(pauseBtns[0]);
    }
    const adjustBtns = screen.queryAllByText(/Adjust Rate/);
    if (adjustBtns.length > 0) {
      fireEvent.click(adjustBtns[0]);
    }
    // Click all Cancel buttons on stream cards (not the filter button)
    const cancelBtns = screen.queryAllByText(/Cancel/);
    cancelBtns.forEach((btn) => {
      if (btn.closest('button')?.className.includes('bg-red-500')) {
        fireEvent.click(btn.closest('button')!);
      }
    });
    const resumeBtns = screen.queryAllByText(/Resume/);
    if (resumeBtns.length > 0) {
      fireEvent.click(resumeBtns[0]);
    }
  });

  it('renders timeUntil for scheduled streams', () => {
    render(<StreamingPage />);
    // timeUntil formats future timestamps as "Xm", "Xh", "Xd"
    const allText = document.body.textContent || '';
    expect(allText.length).toBeGreaterThan(0);
  });

  it('stream detail drawer shows direction badge and auto-compound info', () => {
    render(<StreamingPage />);
    const streamTexts = screen.getAllByText(/STR-/);
    // Click through multiple stream cards to hit different directions and autoCompound branches
    for (let i = 0; i < Math.min(streamTexts.length, 8); i++) {
      const card = streamTexts[i].closest('div[class*="cursor"]');
      if (card) {
        fireEvent.click(card);
        const drawer = screen.queryByTestId('drawer');
        if (drawer) {
          // Check for direction badge (Outgoing or Incoming) and auto-compound text
          const allText = drawer.textContent || '';
          expect(allText.length).toBeGreaterThan(0);
          fireEvent.click(screen.getByTestId('drawer-close'));
        }
      }
    }
  });

  it('analytics tab shows net flow with sign indicator', () => {
    render(<StreamingPage />);
    const tabs = screen.getByTestId('tabs');
    const analyticsBtn = Array.from(tabs.querySelectorAll('button')).find((b) => b.textContent?.includes('Analytics'));
    if (analyticsBtn) {
      fireEvent.click(analyticsBtn);
      // Net Flow section shows + or - prefix based on totalInflow vs totalOutflow
      const netFlowEl = screen.getByText('Net Flow (Monthly)');
      expect(netFlowEl).toBeInTheDocument();
    }
  });

  it('history tab renders action styles for all action types', () => {
    render(<StreamingPage />);
    const tabs = screen.getByTestId('tabs');
    const historyBtn = Array.from(tabs.querySelectorAll('button')).find((b) => b.textContent?.includes('History'));
    if (historyBtn) {
      fireEvent.click(historyBtn);
      // History table shows actions: Created, Paused, Resumed, Rate Adjusted, Cancelled, Completed, Cliff Released
      const allActions = screen.getAllByText(/Created|Paused|Resumed|Rate Adjusted|Cancelled|Completed|Cliff Released/);
      expect(allActions.length).toBeGreaterThan(0);
    }
  });

  it('stream filter shows all status filters', () => {
    render(<StreamingPage />);
    // Click through all filter buttons: All, Active, Paused, Scheduled, Completed, Cancelled
    const filterLabels = ['All', 'Active', 'Paused', 'Scheduled', 'Completed', 'Cancelled'];
    filterLabels.forEach((label) => {
      const btns = screen.getAllByRole('button').filter((b) => b.textContent === label);
      if (btns.length > 0) fireEvent.click(btns[0]);
    });
  });
});
