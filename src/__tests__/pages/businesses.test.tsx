import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BusinessesPage from "@/pages/businesses";

const mockUseBusinessProfile = jest.fn();
const mockUseBusinessPaymentLimits = jest.fn();
const mockUseBusinessRegistered = jest.fn();
const mockUseBusinessRegistration = jest.fn();
const mockRegister = jest.fn();
const mockNotify = jest.fn();
const mockSignIn = jest.fn();
let mockAuthenticated = true;

jest.mock("@/config/chains", () => ({
  CONTRACT_ADDRESSES: { businessRegistry: "0xregistry" },
  activeChain: {
    blockExplorers: { default: { url: "https://explorer.test" } },
  },
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    wallet: {
      connected: true,
      isWrongNetwork: false,
      address: "0x1111111111111111111111111111111111111111",
    },
    addNotification: mockNotify,
  }),
}));
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    isAuthenticated: mockAuthenticated,
    isSigningIn: false,
    signIn: mockSignIn,
  }),
}));
jest.mock("@/hooks/useBusiness", () => ({
  useBusinessProfile: () => mockUseBusinessProfile(),
  useBusinessPaymentLimits: () => mockUseBusinessPaymentLimits(),
  useBusinessRegistered: () => mockUseBusinessRegistered(),
  useBusinessRegistration: () => mockUseBusinessRegistration(),
}));
jest.mock("@/components/SharedComponents", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
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
}));

const query = (data: unknown) => ({
  data,
  isLoading: false,
  error: null,
  refetch: jest.fn(),
});
const profile = {
  id: "business-1",
  businessName: "Acme LLC",
  kycStatus: "VERIFIED",
  tier: "ENTERPRISE",
  address: "0x1111",
  licenseNumber: "LIC-1",
  jurisdiction: "AE",
  businessType: "Trading",
  contactEmail: "ops@acme.test",
  complianceOfficer: "0xofficer",
  registeredAt: Date.UTC(2026, 0, 1),
};

describe("BusinessesPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticated = true;
    mockUseBusinessProfile.mockReturnValue(query(profile));
    mockUseBusinessPaymentLimits.mockReturnValue(
      query({
        daily: { remaining: "90", limit: "100", used: "10", transactions: 1 },
        monthly: {
          remaining: "900",
          limit: "1000",
          used: "100",
          transactions: 2,
        },
      }),
    );
    mockUseBusinessRegistered.mockReturnValue({
      isRegistered: true,
      kycStatus: "VERIFIED",
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockRegister.mockResolvedValue({});
    mockUseBusinessRegistration.mockReturnValue({
      register: mockRegister,
      data: null,
      error: null,
      isPending: false,
      isConfirming: false,
    });
  });

  it("renders the authenticated tenant registry profile", () => {
    render(<BusinessesPage />);
    expect(screen.getByText("Acme LLC")).toBeInTheDocument();
    expect(screen.getByText("LIC-1")).toBeInTheDocument();
    expect(screen.queryByText(/seed/i)).not.toBeInTheDocument();
  });

  it("registers an unregistered wallet with real form values", async () => {
    mockAuthenticated = false;
    mockUseBusinessRegistered.mockReturnValue({
      isRegistered: false,
      kycStatus: undefined,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<BusinessesPage />);
    fireEvent.change(screen.getByLabelText("Registered business name"), {
      target: { value: "New Co" },
    });
    fireEvent.change(screen.getByLabelText("License number"), {
      target: { value: "NEW-01" },
    });
    fireEvent.change(screen.getByLabelText("Business type"), {
      target: { value: "Services" },
    });
    fireEvent.change(screen.getByLabelText("Contact email"), {
      target: { value: "new@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Register on Aethelred" }),
    );
    await waitFor(() =>
      expect(mockRegister).toHaveBeenCalledWith(
        expect.objectContaining({
          businessName: "New Co",
          licenseNumber: "NEW-01",
          jurisdiction: "UAE",
          businessType: "Services",
          contactEmail: "new@example.test",
          complianceOfficer: "0x1111111111111111111111111111111111111111",
        }),
      ),
    );
  });

  it("shows the signed-session gate for an already registered wallet", () => {
    mockAuthenticated = false;
    mockUseBusinessRegistered.mockReturnValue({
      isRegistered: true,
      kycStatus: "VERIFIED",
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<BusinessesPage />);
    expect(
      screen.queryByText("Register this business"),
    ).not.toBeInTheDocument();
  });

  it("explains that a pending on-chain registration cannot sign in yet", () => {
    mockAuthenticated = false;
    mockUseBusinessRegistered.mockReturnValue({
      isRegistered: true,
      kycStatus: "PENDING",
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    render(<BusinessesPage />);
    expect(screen.getByText("KYC verification pending")).toBeInTheDocument();
    expect(
      screen.getByText(/Ask the verifier or platform operator/i),
    ).toBeInTheDocument();
  });

  it("does not offer sign-in immediately after a pending registration", () => {
    mockAuthenticated = false;
    mockUseBusinessRegistered.mockReturnValue({
      isRegistered: false,
      kycStatus: undefined,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUseBusinessRegistration.mockReturnValue({
      register: mockRegister,
      data: {
        business: { businessName: "New Co" },
        apiKey: "npk_once",
      },
      error: null,
      isPending: false,
      isConfirming: false,
    });
    render(<BusinessesPage />);
    expect(
      screen.getByText("Registration confirmed — verification pending"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in with wallet/i }),
    ).not.toBeInTheDocument();
  });
});
