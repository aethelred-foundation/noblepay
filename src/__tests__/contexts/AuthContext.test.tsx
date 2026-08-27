import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth, useOptionalAuth } from "@/contexts/AuthContext";
import { ApiError } from "@/lib/api";

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const business = {
  id: "business-1",
  address: ADDRESS,
  businessName: "Acme LLC",
  kycStatus: "VERIFIED",
  tier: "ENTERPRISE",
  contactEmail: "ops@acme.test",
};

let mockAccount = { address: ADDRESS, isConnected: true };
let mockSessionQuery: any;
const mockSignMessageAsync = jest.fn();
const mockApiRequest = jest.fn();
const mockRemoveQueries = jest.fn();
const mockSetQueryData = jest.fn();
const mockQueryClient = {
  removeQueries: mockRemoveQueries,
  setQueryData: mockSetQueryData,
};

jest.mock("wagmi", () => ({
  useAccount: () => mockAccount,
  useSignMessage: () => ({ signMessageAsync: mockSignMessageAsync }),
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: () => mockSessionQuery,
  useQueryClient: () => mockQueryClient,
}));

jest.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    code: string;

    constructor(
      message: string,
      options: { status?: number; code?: string } = {},
    ) {
      super(message);
      this.name = "ApiError";
      this.status = options.status ?? 0;
      this.code = options.code ?? "API_REQUEST_FAILED";
    }
  }

  return {
    ApiError: MockApiError,
    apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  };
});

function AuthProbe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="business">
        {auth.business?.businessName ?? "none"}
      </span>
      <span data-testid="authenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="checking">{String(auth.isCheckingSession)}</span>
      <span data-testid="signing">{String(auth.isSigningIn)}</span>
      {auth.error ? <span role="alert">{auth.error}</span> : null}
      <button onClick={() => void auth.signIn().catch(() => undefined)}>
        Sign in
      </button>
      <button onClick={() => void auth.signOut()}>Sign out</button>
      <button onClick={() => void auth.refreshSession()}>Refresh</button>
    </div>
  );
}

function OptionalProbe() {
  return <span>{useOptionalAuth() ? "inside" : "outside"}</span>;
}

describe("AuthContext", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount = { address: ADDRESS, isConnected: true };
    mockSessionQuery = {
      data: null,
      isLoading: false,
      refetch: jest.fn().mockResolvedValue({ data: null }),
    };
    mockSignMessageAsync.mockResolvedValue("0xsignedchallenge");
  });

  it("accepts only a session bound to the connected wallet", () => {
    mockSessionQuery.data = business;
    const { rerender } = render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    expect(screen.getByTestId("business")).toHaveTextContent("Acme LLC");
    expect(screen.getByTestId("authenticated")).toHaveTextContent("true");

    mockSessionQuery = {
      ...mockSessionQuery,
      data: {
        ...business,
        address: "0x1111111111111111111111111111111111111111",
      },
    };
    rerender(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("business")).toHaveTextContent("none");
    expect(screen.getByTestId("authenticated")).toHaveTextContent("false");
  });

  it("signs the short-lived server challenge and caches the verified business", async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path === "/v1/auth/challenge") {
        return Promise.resolve({
          challengeId: "challenge-1",
          message: "Sign in to NoblePay",
          expiresAt: "2026-07-21T10:05:00Z",
        });
      }
      if (path === "/v1/auth/verify") {
        return Promise.resolve({ business, expiresIn: 900 });
      }
      throw new Error(`Unexpected API path ${path}`);
    });
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mockSetQueryData).toHaveBeenCalled());
    expect(mockApiRequest).toHaveBeenNthCalledWith(1, "/v1/auth/challenge", {
      method: "POST",
      json: { address: ADDRESS },
      csrf: "omit",
    });
    expect(mockSignMessageAsync).toHaveBeenCalledWith({
      message: "Sign in to NoblePay",
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(2, "/v1/auth/verify", {
      method: "POST",
      json: {
        address: ADDRESS,
        challengeId: "challenge-1",
        signature: "0xsignedchallenge",
      },
      csrf: "omit",
    });
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ["auth-session", ADDRESS.toLowerCase()],
      business,
    );
  });

  it("refuses authentication while the wallet is disconnected", async () => {
    mockAccount = {
      address: undefined as unknown as string,
      isConnected: false,
    };
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connect your wallet before signing in.",
    );
    expect(mockApiRequest).not.toHaveBeenCalled();
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ["auth-session"],
    });
  });

  it("surfaces challenge failures and always clears the signing state", async () => {
    mockApiRequest.mockRejectedValue(new Error("Wallet challenge unavailable"));
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Wallet challenge unavailable",
    );
    expect(screen.getByTestId("signing")).toHaveTextContent("false");
  });

  it("logs out authenticated sessions and clears cached identity", async () => {
    mockSessionQuery.data = business;
    mockApiRequest.mockResolvedValue(undefined);
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(mockApiRequest).toHaveBeenCalledWith("/v1/auth/logout", {
        method: "POST",
      }),
    );
    expect(mockRemoveQueries).toHaveBeenCalledWith({
      queryKey: ["auth-session"],
    });
  });

  it("treats an expired logout session as signed out and can refresh active sessions", async () => {
    mockSessionQuery.data = business;
    mockApiRequest.mockRejectedValue(
      new ApiError("Session expired", { status: 401 }),
    );
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(mockRemoveQueries).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockSessionQuery.refetch).toHaveBeenCalled());
  });

  it("offers a safe optional consumer outside the provider", () => {
    render(<OptionalProbe />);
    expect(screen.getByText("outside")).toBeInTheDocument();
  });
});
