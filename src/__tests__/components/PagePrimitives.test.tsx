import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  GlassCard,
  CopyButton,
  SectionHeader,
  Sparkline,
  ComplianceStatusBadge,
  RiskScoreBar,
  PaymentStatusPill,
  BusinessTierBadge,
  CurrencyDisplay,
  EncryptedFieldDisplay,
  ChartTooltip,
  StatusBadge,
} from '@/components/PagePrimitives';

// Mock lucide-react
jest.mock('lucide-react', () => ({
  Copy: (props: any) => <span data-testid="copy-icon" {...props} />,
  Check: (props: any) => <span data-testid="check-icon" {...props} />,
  Lock: (props: any) => <span data-testid="lock-icon" {...props} />,
  Shield: (props: any) => <span data-testid="shield-icon" {...props} />,
  Building2: (props: any) => <span data-testid="building-icon" {...props} />,
}));

// Mock utils and constants
jest.mock('@/lib/utils', () => ({
  copyToClipboard: jest.fn().mockResolvedValue(undefined),
  formatFullNumber: (n: number) => n.toLocaleString('en-US'),
  formatCurrency: (amount: number, currency: string) => `${amount} ${currency}`,
  getRiskColor: (score: number) => {
    if (score <= 25) return '#22c55e';
    if (score <= 50) return '#f59e0b';
    if (score <= 75) return '#f97316';
    return '#ef4444';
  },
  maskSensitiveData: (data: string, start: number, end: number) => {
    if (data.length <= start + end) return data;
    return `${data.slice(0, start)}****${data.slice(-end)}`;
  },
}));

jest.mock('@/lib/constants', () => ({
  BRAND: { red: '#DC2626' },
  PAYMENT_STATUS_STYLES: {
    Pending: { bg: 'bg-amber-500/20', text: 'text-amber-400', dot: 'bg-amber-400' },
    Settled: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400' },
    Screening: { bg: 'bg-blue-500/20', text: 'text-blue-400', dot: 'bg-blue-400' },
  },
  COMPLIANCE_STATUS_STYLES: {
    Clear: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
    Pending: { bg: 'bg-slate-500/20', text: 'text-slate-400' },
    Review: { bg: 'bg-amber-500/20', text: 'text-amber-400' },
  },
  RISK_LEVEL_STYLES: {
    Low: { bg: 'bg-emerald-500/20', text: 'text-emerald-400' },
  },
  TIER_BY_ID: {
    0: { label: 'Standard', bg: 'bg-slate-500/20', color: 'text-slate-400' },
    1: { label: 'Premium', bg: 'bg-blue-500/20', color: 'text-blue-400' },
    2: { label: 'Enterprise', bg: 'bg-amber-500/20', color: 'text-amber-400' },
  },
}));

describe('GlassCard', () => {
  it('renders children', () => {
    render(<GlassCard>Card content</GlassCard>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<GlassCard className="custom-class">Content</GlassCard>);
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('applies hover styles by default', () => {
    const { container } = render(<GlassCard>Content</GlassCard>);
    expect(container.firstChild).toHaveClass('hover:border-slate-600/60');
  });

  it('disables hover when hover=false', () => {
    const { container } = render(<GlassCard hover={false}>Content</GlassCard>);
    expect(container.firstChild).not.toHaveClass('hover:border-slate-600/60');
  });

  it('applies cursor-pointer when onClick is provided', () => {
    const onClick = jest.fn();
    const { container } = render(<GlassCard onClick={onClick}>Content</GlassCard>);
    expect(container.firstChild).toHaveClass('cursor-pointer');
  });

  it('calls onClick handler', () => {
    const onClick = jest.fn();
    render(<GlassCard onClick={onClick}>Content</GlassCard>);
    fireEvent.click(screen.getByText('Content'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('CopyButton', () => {
  it('renders copy icon initially', () => {
    render(<CopyButton text="test" />);
    expect(screen.getByLabelText('Copy to clipboard')).toBeInTheDocument();
  });

  it('has correct title attribute', () => {
    render(<CopyButton text="test" />);
    expect(screen.getByTitle('Copy to clipboard')).toBeInTheDocument();
  });

  it('calls copyToClipboard on click', () => {
    const { copyToClipboard } = require('@/lib/utils');
    render(<CopyButton text="some text" />);

    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    expect(copyToClipboard).toHaveBeenCalledWith('some text');
  });

  it('calls onCopied callback', () => {
    const onCopied = jest.fn();
    render(<CopyButton text="test" onCopied={onCopied} />);

    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    expect(onCopied).toHaveBeenCalledTimes(1);
  });

  it('shows check icon after copy', () => {
    render(<CopyButton text="test" />);
    fireEvent.click(screen.getByTitle('Copy to clipboard'));

    expect(screen.getByLabelText('Copied')).toBeInTheDocument();
  });

  it('reverts check icon back to copy after timeout', () => {
    jest.useFakeTimers();
    render(<CopyButton text="test" />);
    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    expect(screen.getByLabelText('Copied')).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(2100); });
    expect(screen.getByLabelText('Copy to clipboard')).toBeInTheDocument();
    jest.useRealTimers();
  });

  it('stops propagation by default', () => {
    const parentHandler = jest.fn();
    render(
      <div onClick={parentHandler}>
        <CopyButton text="test" />
      </div>,
    );

    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    expect(parentHandler).not.toHaveBeenCalled();
  });

  it('does not stop propagation when stopPropagation=false', () => {
    const parentHandler = jest.fn();
    render(
      <div onClick={parentHandler}>
        <CopyButton text="test" stopPropagation={false} />
      </div>,
    );

    fireEvent.click(screen.getByTitle('Copy to clipboard'));
    expect(parentHandler).toHaveBeenCalledTimes(1);
  });

  it('renders with md size', () => {
    const { container } = render(<CopyButton text="test" size="md" />);
    expect(container.querySelector('button')).toBeInTheDocument();
  });
});

describe('SectionHeader', () => {
  it('renders title', () => {
    render(<SectionHeader title="Test Title" />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<SectionHeader title="Title" subtitle="Subtitle text" />);
    expect(screen.getByText('Subtitle text')).toBeInTheDocument();
  });

  it('does not render subtitle when not provided', () => {
    const { container } = render(<SectionHeader title="Title" />);
    const p = container.querySelector('p');
    expect(p).toBeNull();
  });

  it('renders action when provided', () => {
    render(
      <SectionHeader title="Title" action={<button>Action</button>} />,
    );
    expect(screen.getByText('Action')).toBeInTheDocument();
  });

  it('applies large size by default', () => {
    render(<SectionHeader title="Title" />);
    const heading = screen.getByText('Title');
    expect(heading).toHaveClass('text-2xl');
  });

  it('applies small size when specified', () => {
    render(<SectionHeader title="Title" size="sm" />);
    const heading = screen.getByText('Title');
    expect(heading).toHaveClass('text-xl');
  });
});

describe('Sparkline', () => {
  it('renders an SVG', () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 4, 5]} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders with custom dimensions', () => {
    const { container } = render(
      <Sparkline data={[1, 2, 3]} width={100} height={50} />,
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '100');
    expect(svg).toHaveAttribute('height', '50');
  });

  it('is hidden from screen readers', () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a polyline with data points', () => {
    const { container } = render(<Sparkline data={[10, 20, 30]} />);
    // After mount effect, polyline should exist
    const polyline = container.querySelector('polyline');
    expect(polyline).toBeInTheDocument();
  });

  it('renders gradient when showGradient=true', () => {
    const { container } = render(<Sparkline data={[10, 20, 30]} showGradient />);
    const gradient = container.querySelector('linearGradient');
    expect(gradient).toBeInTheDocument();
  });

  it('renders with custom color', () => {
    const { container } = render(<Sparkline data={[10, 20, 30]} color="#10B981" />);
    const polyline = container.querySelector('polyline');
    expect(polyline).toHaveAttribute('stroke', '#10B981');
  });

  it('handles all equal data points without division by zero', () => {
    const { container } = render(<Sparkline data={[5, 5, 5, 5]} />);
    const polyline = container.querySelector('polyline');
    expect(polyline).toBeInTheDocument();
  });
});

describe('ComplianceStatusBadge', () => {
  it('renders the status text', () => {
    render(<ComplianceStatusBadge status="Clear" />);
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('renders shield icon', () => {
    render(<ComplianceStatusBadge status="Clear" />);
    expect(screen.getByTestId('shield-icon')).toBeInTheDocument();
  });

  it('falls back to Pending styles for unknown status', () => {
    // @ts-ignore - testing unknown status
    render(<ComplianceStatusBadge status="UnknownStatus" />);
    expect(screen.getByText('UnknownStatus')).toBeInTheDocument();
  });
});

describe('RiskScoreBar', () => {
  it('renders with label by default', () => {
    render(<RiskScoreBar score={50} />);
    expect(screen.getByText('50/100')).toBeInTheDocument();
  });

  it('hides label when showLabel=false', () => {
    render(<RiskScoreBar score={50} showLabel={false} />);
    expect(screen.queryByText('50/100')).not.toBeInTheDocument();
  });

  it('clamps score to 0-100 range', () => {
    render(<RiskScoreBar score={150} />);
    expect(screen.getByText('100/100')).toBeInTheDocument();
  });

  it('clamps negative score to 0', () => {
    render(<RiskScoreBar score={-10} />);
    expect(screen.getByText('0/100')).toBeInTheDocument();
  });

  it('renders with md height', () => {
    const { container } = render(<RiskScoreBar score={50} height="md" />);
    expect(container.querySelector('.h-2\\.5')).toBeInTheDocument();
  });
});

describe('PaymentStatusPill', () => {
  it('renders the status text', () => {
    render(<PaymentStatusPill status="Pending" />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('renders Settled status', () => {
    render(<PaymentStatusPill status="Settled" />);
    expect(screen.getByText('Settled')).toBeInTheDocument();
  });

  it('renders with fallback styles for unknown status', () => {
    // @ts-ignore - testing unknown status
    render(<PaymentStatusPill status="Unknown" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('applies pulse animation for Screening status', () => {
    const { container } = render(<PaymentStatusPill status="Screening" />);
    const dot = container.querySelector('.animate-pulse');
    expect(dot).toBeInTheDocument();
  });
});

describe('BusinessTierBadge', () => {
  it('renders Standard tier', () => {
    render(<BusinessTierBadge tierId={0} />);
    expect(screen.getByText('Standard')).toBeInTheDocument();
  });

  it('renders Premium tier', () => {
    render(<BusinessTierBadge tierId={1} />);
    expect(screen.getByText('Premium')).toBeInTheDocument();
  });

  it('renders Enterprise tier', () => {
    render(<BusinessTierBadge tierId={2} />);
    expect(screen.getByText('Enterprise')).toBeInTheDocument();
  });

  it('renders building icon', () => {
    render(<BusinessTierBadge tierId={0} />);
    expect(screen.getByTestId('building-icon')).toBeInTheDocument();
  });

  it('falls back to Standard for unknown tier', () => {
    render(<BusinessTierBadge tierId={99} />);
    expect(screen.getByText('Standard')).toBeInTheDocument();
  });
});

describe('CurrencyDisplay', () => {
  it('renders formatted amount with currency', () => {
    render(<CurrencyDisplay amount={1000} currency="USDC" />);
    expect(screen.getByText('1000 USDC')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <CurrencyDisplay amount={500} currency="USD" className="text-lg" />,
    );
    expect(container.firstChild).toHaveClass('text-lg');
  });

  it('applies tabular-nums class', () => {
    const { container } = render(
      <CurrencyDisplay amount={100} currency="AET" />,
    );
    expect(container.firstChild).toHaveClass('tabular-nums');
  });
});

describe('EncryptedFieldDisplay', () => {
  it('renders label and masked value', () => {
    render(<EncryptedFieldDisplay value="1234567890" label="Account" />);
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('1234****7890')).toBeInTheDocument();
  });

  it('renders lock icon', () => {
    render(<EncryptedFieldDisplay value="test" label="Field" />);
    expect(screen.getByTestId('lock-icon')).toBeInTheDocument();
  });

  it('shows Reveal button when revealable', () => {
    render(
      <EncryptedFieldDisplay value="1234567890" label="Secret" revealable />,
    );
    expect(screen.getByText('Reveal')).toBeInTheDocument();
  });

  it('does not show Reveal button when not revealable', () => {
    render(
      <EncryptedFieldDisplay value="1234567890" label="Secret" />,
    );
    expect(screen.queryByText('Reveal')).not.toBeInTheDocument();
  });

  it('toggles between masked and revealed on click', () => {
    render(
      <EncryptedFieldDisplay value="1234567890" label="Secret" revealable />,
    );

    // Initially masked
    expect(screen.getByText('1234****7890')).toBeInTheDocument();

    // Click Reveal
    fireEvent.click(screen.getByText('Reveal'));
    expect(screen.getByText('1234567890')).toBeInTheDocument();
    expect(screen.getByText('Hide')).toBeInTheDocument();

    // Click Hide
    fireEvent.click(screen.getByText('Hide'));
    expect(screen.getByText('1234****7890')).toBeInTheDocument();
  });
});

describe('ChartTooltip', () => {
  it('returns null when not active', () => {
    const { container } = render(<ChartTooltip active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when payload is empty', () => {
    const { container } = render(<ChartTooltip active={true} payload={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders tooltip content when active with payload', () => {
    render(
      <ChartTooltip
        active={true}
        payload={[{ color: '#DC2626', name: 'Volume', value: 1000 }]}
        label="Jan"
      />,
    );
    expect(screen.getByText('Jan')).toBeInTheDocument();
    expect(screen.getByText(/Volume/)).toBeInTheDocument();
  });

  it('uses custom formatValue function', () => {
    render(
      <ChartTooltip
        active={true}
        payload={[{ color: '#DC2626', name: 'Amount', value: 1000 }]}
        formatValue={(v) => `$${v}`}
      />,
    );
    expect(screen.getByText(/\$1000/)).toBeInTheDocument();
  });

  it('handles string values with default formatter', () => {
    render(
      <ChartTooltip
        active={true}
        payload={[{ color: '#DC2626', name: 'Category', value: 'HighRisk' }]}
      />,
    );
    expect(screen.getByText(/HighRisk/)).toBeInTheDocument();
  });
});

describe('StatusBadge', () => {
  it('renders status text with proper capitalization', () => {
    render(<StatusBadge status="Active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders Pending status', () => {
    render(<StatusBadge status="Pending" />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('renders with fallback styles for unknown status', () => {
    render(<StatusBadge status="custom" />);
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('applies pulse animation for Active status', () => {
    const { container } = render(<StatusBadge status="Active" />);
    const dot = container.querySelector('.animate-pulse');
    expect(dot).toBeInTheDocument();
  });

  it('accepts custom styles', () => {
    const customStyles = {
      Custom: { bg: 'bg-purple-500/20', text: 'text-purple-400', dot: 'bg-purple-400' },
    };
    render(<StatusBadge status="Custom" styles={customStyles} />);
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });
});
