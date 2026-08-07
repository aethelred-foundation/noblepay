/**
 * Tests for the treasury console.
 *
 * The previous suite rendered a page that generated its own contents and then
 * asserted that those contents appeared — "Total AUM", twelve invented
 * proposals, named signers. It passed consistently and told us nothing about
 * whether the page could talk to a contract.
 *
 * These tests drive the page through mocked hook state instead, and cover the
 * behaviour that actually matters for a treasury console: that chain data is
 * rendered faithfully, that authority is gated on SIGNER_ROLE rather than
 * assumed, that the timelock is enforced in the UI as well as the contract,
 * and that empty and error states say so rather than showing plausible
 * filler.
 */

import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

// --- recharts: render nothing; the charts are not what these tests check ----
jest.mock("recharts", () => {
  const R = require("react");
  const stub =
    (name: string) =>
    ({ children }: any) =>
      R.createElement("div", { "data-chart": name }, children);
  return new Proxy(
    {},
    {
      get: (_t, prop: string) =>
        prop === "__esModule" ? true : stub(prop),
    },
  );
});

jest.mock("@/components/SEOHead", () => ({ SEOHead: () => null }));

// SharedComponents reaches AppContext -> src/config/wagmi -> @wagmi/connectors,
// which ships ESM that jest does not transform. Stub the chrome; these tests
// are about treasury behaviour, not the shell.
jest.mock("@/components/SharedComponents", () => ({
  TopNav: () => <nav data-testid="top-nav" />,
  Footer: () => <footer data-testid="footer" />,
  Badge: ({ children }: any) => <span>{children}</span>,
  Modal: ({ open, title, children, onClose }: any) =>
    open ? (
      <div data-testid="modal" aria-label={title}>
        {title}
        {children}
        <button data-testid="modal-close" onClick={onClose}>
          X
        </button>
      </div>
    ) : null,
  Tabs: ({ tabs, active, onChange }: any) => (
    <div data-testid="tabs">
      {tabs.map((t: any) => (
        <button key={t.id} onClick={() => onChange(t.id)} data-active={active === t.id}>
          {t.label}
        </button>
      ))}
    </div>
  ),
}));

jest.mock("@/components/PagePrimitives", () => ({
  GlassCard: ({ children, className }: any) => (
    <div className={className}>{children}</div>
  ),
  SectionHeader: ({ title, subtitle }: any) => (
    <div>
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
  Sparkline: () => <svg data-testid="sparkline" />,
}));

const mockUseAccount = jest.fn();
jest.mock("wagmi", () => ({
  useAccount: () => mockUseAccount(),
}));

// --- treasury hooks --------------------------------------------------------

const NATIVE = "0x0000000000000000000000000000000000000000";
const SIGNER_A = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";

const mockCreateProposal = jest.fn();
const mockApproveProposal = jest.fn();
const mockRejectProposal = jest.fn();
const mockExecuteProposal = jest.fn();
const mockCancelProposal = jest.fn();
const mockCreateBudget = jest.fn();
const mockRefetch = jest.fn();

const mockTreasuryState: any = {};

jest.mock("@/hooks/useTreasury", () => {
  const actual = jest.requireActual("@/hooks/useTreasury");
  return {
    ...actual,
    useTreasury: () => mockTreasuryState.treasury,
    useTreasuryActivity: () => mockTreasuryState.activity,
    useProposalActions: () => ({
      createProposal: mockCreateProposal,
      approveProposal: mockApproveProposal,
      rejectProposal: mockRejectProposal,
      executeProposal: mockExecuteProposal,
      cancelProposal: mockCancelProposal,
      pending: null,
    }),
    useBudgetActions: () => ({ createBudget: mockCreateBudget, pending: false }),
  };
});

import TreasuryPage from "@/pages/treasury";

// --- fixtures --------------------------------------------------------------

const HOUR = 3_600_000;

const proposal = (over: Partial<any> = {}) => ({
  proposalId: "0xaaa",
  proposer: SIGNER_A,
  recipient: RECIPIENT,
  token: NATIVE,
  amount: 2_000_000_000_000_000_000n, // 2 AETHEL
  category: 0,
  description: "Fund the compliance node",
  tier: 1,
  status: 0, // Pending
  approvalCount: 1,
  rejectionCount: 0,
  requiredApprovals: 2,
  createdAt: Date.now() - HOUR,
  timelockExpiry: Date.now() + HOUR,
  expiresAt: Date.now() + 48 * HOUR,
  isEmergency: false,
  budgetId: `0x${"0".repeat(64)}`,
  ...over,
});

const defaultTreasury = (over: Partial<any> = {}) => ({
  summary: {
    nativeBalance: 10_000_000_000_000_000_000n, // 10 AETHEL
    tokens: [],
    pendingProposals: 1,
    approvedAwaitingExecution: 0,
    executedProposals: 0,
    totalSigners: 3,
    activeBudgets: 0,
    deployedInYield: 0n,
  },
  proposals: [proposal()],
  budgets: [],
  protocols: [],
  signers: [SIGNER_A],
  signerConfig: {
    totalSigners: 3,
    smallThreshold: 1,
    mediumThreshold: 2,
    largeThreshold: 3,
    emergencyThreshold: 3,
  },
  tiers: [
    {
      tier: "Small",
      minAmount: 0n,
      maxAmount: 10_000_000_000n,
      requiredSignatures: 1,
      timelockSeconds: 86_400,
    },
  ],
  isSigner: true,
  isAdmin: false,
  isLoading: false,
  error: null,
  refetch: mockRefetch,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAccount.mockReturnValue({ address: SIGNER_A, isConnected: true });
  mockTreasuryState.treasury = defaultTreasury();
  mockTreasuryState.activity = {
    activity: [],
    isLoading: false,
    error: null,
    refetch: jest.fn(),
  };
});

// ---------------------------------------------------------------------------

describe("treasury overview", () => {
  it("renders the native balance from chain state", () => {
    render(<TreasuryPage />);
    expect(screen.getByText(/10\.00 AETHEL/)).toBeInTheDocument();
  });

  it("describes the treasury as a multi-sig, not token voting", () => {
    render(<TreasuryPage />);
    expect(screen.getByText(/not token voting/i)).toBeInTheDocument();
  });

  it("shows the approval matrix read from contract thresholds", () => {
    render(<TreasuryPage />);
    expect(screen.getByText("Approval matrix")).toBeInTheDocument();
    expect(screen.getByText("Small")).toBeInTheDocument();
  });

  it("lists signers by address, without inventing names", () => {
    render(<TreasuryPage />);
    expect(screen.getByText(SIGNER_A)).toBeInTheDocument();
  });

  it("surfaces a contract read error instead of rendering empty", () => {
    mockTreasuryState.treasury = defaultTreasury({
      error: new Error("execution reverted"),
    });
    render(<TreasuryPage />);
    expect(screen.getByText(/Could not read the treasury contract/i)).toBeInTheDocument();
    expect(screen.getByText(/execution reverted/)).toBeInTheDocument();
  });

  it("reports uncommitted balance net of pending outflow", () => {
    // 10 held, 2 committed by the pending proposal -> 8 uncommitted.
    render(<TreasuryPage />);
    expect(screen.getByText(/8\.00 AETHEL uncommitted/)).toBeInTheDocument();
  });

  it("says so when no executed proposals exist rather than drawing a curve", () => {
    render(<TreasuryPage />);
    expect(screen.getByText(/No executed proposals yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing disbursed yet/i)).toBeInTheDocument();
  });
});

describe("proposals tab", () => {
  const openProposals = () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Proposals \(1\)/));
  };

  it("renders the on-chain description and approval progress", () => {
    openProposals();
    expect(screen.getByText("Fund the compliance node")).toBeInTheDocument();
    expect(screen.getByText("1/2 approvals")).toBeInTheDocument();
  });

  it("filters by contract status", () => {
    openProposals();
    fireEvent.click(screen.getByRole("button", { name: "Executed" }));
    expect(screen.getByText(/No proposals match this filter/i)).toBeInTheDocument();
  });

  it("shows an empty state when the treasury has no proposals", () => {
    mockTreasuryState.treasury = defaultTreasury({ proposals: [] });
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Proposals \(0\)/));
    expect(screen.getByText(/No proposals yet/i)).toBeInTheDocument();
  });
});

describe("proposal authority", () => {
  const openDetail = () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Proposals \(1\)/));
    fireEvent.click(screen.getByText("Fund the compliance node"));
  };

  it("offers approve and reject to a signer", () => {
    openDetail();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("calls approveProposal with the proposal id", () => {
    mockApproveProposal.mockResolvedValue("0xhash");
    openDetail();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(mockApproveProposal).toHaveBeenCalledWith("0xaaa");
  });

  it("withholds approve/reject from a non-signer and explains why", () => {
    mockTreasuryState.treasury = defaultTreasury({ isSigner: false });
    openDetail();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/does not hold SIGNER_ROLE/i)).toBeInTheDocument();
  });

  it("disables execute until the timelock has elapsed", () => {
    mockTreasuryState.treasury = defaultTreasury({
      proposals: [proposal({ status: 1, timelockExpiry: Date.now() + HOUR })],
    });
    openDetail();
    expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
  });

  it("enables execute once the timelock has passed", () => {
    mockTreasuryState.treasury = defaultTreasury({
      proposals: [proposal({ status: 1, timelockExpiry: Date.now() - HOUR })],
    });
    openDetail();
    expect(screen.getByRole("button", { name: "Execute" })).toBeEnabled();
  });

  it("offers cancel to the proposer only", () => {
    mockUseAccount.mockReturnValue({ address: RECIPIENT, isConnected: true });
    openDetail();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});

describe("amount and tier honesty", () => {
  /**
   * MultiSigTreasury.createProposal compares the raw `_amount` against
   * SMALL_TX_THRESHOLD (10_000 * 1e6, written as USD at six decimals) and then
   * passes that same value straight to safeTransfer. The tier therefore only
   * means "US dollars" for a six-decimal, dollar-pegged token. For an
   * 18-decimal asset the number is wei, and the approval requirement stops
   * tracking the value being moved. The UI must not launder that into a
   * confident dollar range.
   */
  it("warns that tier bounds are not dollars for other assets", () => {
    render(<TreasuryPage />);
    expect(
      screen.getByText(/only read as US dollars for a/i),
    ).toBeInTheDocument();
  });

  it("labels a tier derived from a non-six-decimal asset", () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Proposals \(1\)/));
    fireEvent.click(screen.getByText("Fund the compliance node"));
    expect(screen.getByText(/derived from raw units, not value/i)).toBeInTheDocument();
  });

  it("does not render a non-zero dust amount as plain zero", () => {
    // 5e10 wei of an 18-decimal asset is 0.00000005 — real, but it rounds
    // away at six places. Showing "0 AETHEL" for a live proposal would be a
    // lie about a transfer that will actually move funds.
    mockTreasuryState.treasury = defaultTreasury({
      proposals: [proposal({ amount: 50_000_000_000n })],
    });
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Proposals \(1\)/));
    expect(screen.getByText(/<0\.000001 AETHEL/)).toBeInTheDocument();
  });

  it("renders an exact zero as zero", () => {
    mockTreasuryState.treasury = defaultTreasury({
      summary: { ...defaultTreasury().summary, nativeBalance: 0n },
    });
    render(<TreasuryPage />);
    expect(screen.getByText(/^0 AETHEL$/)).toBeInTheDocument();
  });
});

describe("new proposal form", () => {
  const openForm = () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByRole("button", { name: /New proposal/i }));
  };

  it("rejects a malformed recipient address before sending a transaction", () => {
    openForm();
    fireEvent.change(screen.getByPlaceholderText("0x…"), {
      target: { value: "not-an-address" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create proposal/i }));
    expect(screen.getByText(/must be a 20-byte hex address/i)).toBeInTheDocument();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", () => {
    openForm();
    fireEvent.change(screen.getByPlaceholderText("0x…"), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create proposal/i }));
    expect(screen.getByText(/greater than zero/i)).toBeInTheDocument();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  it("converts a decimal amount to 18-decimal native units", () => {
    mockCreateProposal.mockResolvedValue("0xhash");
    openForm();
    fireEvent.change(screen.getByPlaceholderText("0x…"), {
      target: { value: RECIPIENT },
    });
    fireEvent.change(screen.getByPlaceholderText("0.0"), {
      target: { value: "1.5" },
    });
    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "test payment" } });
    fireEvent.click(screen.getByRole("button", { name: /Create proposal/i }));
    expect(mockCreateProposal).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_500_000_000_000_000_000n }),
    );
  });

  it("warns that a native proposal is funded at creation", () => {
    openForm();
    expect(screen.getByText(/funded at creation/i)).toBeInTheDocument();
  });
});

describe("budgets tab", () => {
  it("shows an empty state when no budgets are active", () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Budgets \(0\)/));
    expect(screen.getByText(/No active budgets/i)).toBeInTheDocument();
  });

  it("renders allocation and rolling spend for a real budget", () => {
    mockTreasuryState.treasury = defaultTreasury({
      budgets: [
        {
          budgetId: "0xb1",
          name: "Infrastructure Q3",
          category: 2,
          totalAllocation: 100_000_000_000n, // $100k, 6dp
          spent: 25_000_000_000n,
          dailyLimit: 5_000_000_000n,
          weeklyLimit: 20_000_000_000n,
          monthlyLimit: 50_000_000_000n,
          createdAt: Date.now(),
          periodStart: Date.now(),
          periodEnd: Date.now() + 30 * 24 * HOUR,
          active: true,
          dailySpent: 1_000_000_000n,
          weeklySpent: 4_000_000_000n,
          monthlySpent: 25_000_000_000n,
        },
      ],
    });
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Budgets \(1\)/));
    expect(screen.getByText("Infrastructure Q3")).toBeInTheDocument();
    // $25k spent appears both as the headline figure and in the monthly row.
    expect(screen.getAllByText(/\$25\.0K/).length).toBeGreaterThan(0);
    expect(screen.getByText(/of \$100\.0K/)).toBeInTheDocument();
  });
});

describe("yield tab", () => {
  it("explains that no protocols are approved rather than listing venues", () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Yield \(0\)/));
    expect(screen.getByText(/No yield protocols approved/i)).toBeInTheDocument();
  });

  it("states that the contract records allocation but not return", () => {
    mockTreasuryState.treasury = defaultTreasury({
      protocols: [
        {
          protocolAddress: "0xdef1",
          name: "Aethelred Staking",
          maxAllocation: 100_000_000_000n,
          currentAllocation: 40_000_000_000n,
          active: true,
        },
      ],
    });
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText(/Yield \(1\)/));
    expect(screen.getByText("Aethelred Staking")).toBeInTheDocument();
    // No APY is fabricated — the contract has no such field.
    expect(screen.getByText(/records allocation, not return/i)).toBeInTheDocument();
  });
});

describe("activity tab", () => {
  it("renders chain events with block and transaction references", () => {
    mockTreasuryState.activity = {
      activity: [
        {
          kind: "ProposalExecuted",
          blockNumber: 4242n,
          transactionHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          args: {},
        },
      ],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    };
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText("Activity"));
    expect(screen.getByText(/Proposal Executed/)).toBeInTheDocument();
    expect(screen.getByText(/block 4242/)).toBeInTheDocument();
  });

  it("shows an empty state when the treasury has no events", () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByText("Activity"));
    expect(screen.getByText(/No treasury activity/i)).toBeInTheDocument();
  });
});

describe("wallet gating", () => {
  it("disables proposal creation when no wallet is connected", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
    render(<TreasuryPage />);
    expect(screen.getByRole("button", { name: /New proposal/i })).toBeDisabled();
  });
});
