import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/pages/settings";

const mockUseBusinessProfile = jest.fn();
const mockUseUpdateBusiness = jest.fn();
const mockUpdate = jest.fn();
const mockSignOut = jest.fn();
const mockDisconnect = jest.fn();
const mockNotify = jest.fn();

jest.mock("@/config/wagmi", () => ({
  activeChain: { name: "Aethelred Testnet", id: 7331 },
}));
jest.mock("@/config/chains", () => ({
  CONTRACT_ADDRESSES: {
    noblepay: "0xcontract",
    businessRegistry: "",
    paymentChannels: "0xchannels",
    usdcToken: "0xusdc",
    usdtToken: "0xusdt",
  },
}));
jest.mock("@/hooks/useBusiness", () => ({
  useBusinessProfile: () => mockUseBusinessProfile(),
  useUpdateBusiness: () => mockUseUpdateBusiness(),
}));
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ business: { address: "0xwallet" }, signOut: mockSignOut }),
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    disconnectWallet: mockDisconnect,
    addNotification: mockNotify,
  }),
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
  Panel: ({ title, children }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  LoadingState: ({ label }: any) => <div>{label}</div>,
  ErrorState: ({ error }: any) => <div role="alert">{error.message}</div>,
}));

const profile = {
  id: "business-1",
  businessName: "Acme LLC",
  businessType: "Trading",
  contactEmail: "ops@acme.test",
  complianceOfficer: "0xofficer",
  kycStatus: "VERIFIED",
  tier: "ENTERPRISE",
  apiKeys: [
    { id: "key-1", name: "VPS service", status: "ACTIVE", lastUsed: null },
  ],
};

describe("SettingsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseBusinessProfile.mockReturnValue({
      data: profile,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    mockUpdate.mockResolvedValue({});
    mockUseUpdateBusiness.mockReturnValue({
      mutateAsync: mockUpdate,
      isPending: false,
      error: null,
    });
    mockSignOut.mockResolvedValue(undefined);
  });

  it("renders authenticated profile, credential metadata, and runtime targets", () => {
    render(<SettingsPage />);
    expect(screen.getByText("Acme LLC")).toBeInTheDocument();
    expect(screen.getByText("VPS service")).toBeInTheDocument();
    expect(screen.getByText("Aethelred Testnet")).toBeInTheDocument();
    expect(screen.getByText("MISSING")).toBeInTheDocument();
  });

  it("updates only editable profile fields", async () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText("Business type"), {
      target: { value: "Payments" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        businessId: "business-1",
        updates: {
          businessType: "Payments",
          contactEmail: "ops@acme.test",
        },
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      "success",
      "Profile updated",
      expect.any(String),
    );
  });

  it("signs out the HttpOnly session before disconnecting", async () => {
    render(<SettingsPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out and disconnect" }),
    );
    await waitFor(() => expect(mockSignOut).toHaveBeenCalled());
    expect(mockDisconnect).toHaveBeenCalled();
  });
});
