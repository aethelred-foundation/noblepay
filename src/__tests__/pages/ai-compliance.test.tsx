import { render, screen } from "@testing-library/react";
import AICompliancePage from "@/pages/ai-compliance";

const mockUseAICompliance = jest.fn();

jest.mock("@/hooks/useAICompliance", () => ({
  useAICompliance: () => mockUseAICompliance(),
}));
jest.mock("@/components/ProductionPage", () => ({
  PageShell: ({ title, children }: any) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
  SessionGate: ({ children }: any) => children,
  MetricCard: ({ label, value }: any) => (
    <div>
      {label}: {value}
    </div>
  ),
  Panel: ({ title, children }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  LoadingState: ({ label }: any) => <div>{label}</div>,
  ErrorState: ({ error }: any) => <div role="alert">{error.message}</div>,
  EmptyState: ({ title, body }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  ),
}));

const model = {
  id: "model-1",
  name: "Payments Risk",
  version: "1.0.0",
  status: "ACTIVE",
  accuracy: 0.97,
  totalDecisions: 12,
  teeAttested: true,
};
const decision = {
  id: "dec-verified-1",
  paymentId: "payment-1",
  outcome: "ESCALATE",
  confidence: 0.68,
  riskScore: 72,
  humanOverride: false,
};
const appeal = {
  id: "00000000-0000-4000-8000-000000000001",
  paymentId: "payment-1",
  status: "SUBMITTED",
};
const ready = {
  models: [model],
  decisions: [decision],
  reviewQueue: [decision],
  appeals: [appeal],
  analytics: { activeModels: 1, totalDecisions: 1 },
  biasMetrics: [
    { jurisdiction: "AE", totalScreened: 1, flagRate: 1, blockRate: 0 },
  ],
  isLoading: false,
  isMutating: false,
  error: null,
  actionError: null,
  reviewQueueError: null,
  refetch: jest.fn(),
};

describe("AICompliancePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAICompliance.mockReturnValue(ready);
  });

  it("renders archived records without presenting them as verified payment authority", () => {
    render(<AICompliancePage />);
    expect(screen.getAllByText("Payments Risk").length).toBeGreaterThan(0);
    expect(screen.getAllByText("dec-verified-1").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 records/)).toBeInTheDocument();
    expect(
      screen.getByText(/not independently verified on-chain/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Adapter-reported attestation: present/),
    ).toBeInTheDocument();
  });

  it("exposes no unverified mutation controls", () => {
    render(<AICompliancePage />);
    expect(screen.queryByRole("button", { name: /Run decision/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Record override/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Resolve appeal/i }),
    ).toBeNull();
    expect(screen.getByText(/This archive is read-only/)).toBeInTheDocument();
  });

  it("renders server read failures", () => {
    mockUseAICompliance.mockReturnValue({
      ...ready,
      error: new Error("AI decision archive is unavailable"),
    });
    render(<AICompliancePage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "AI decision archive is unavailable",
    );
  });
});
