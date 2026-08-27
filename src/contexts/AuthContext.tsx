import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { apiRequest, ApiError } from "@/lib/api";

export interface AuthenticatedBusiness {
  id: string;
  address: string;
  businessName: string;
  kycStatus: string;
  tier: string;
  contactEmail?: string;
  role?:
    | "SUPER_ADMIN"
    | "ADMIN"
    | "TREASURY_MANAGER"
    | "COMPLIANCE_OFFICER"
    | "ANALYST"
    | "OPERATOR"
    | "VIEWER";
}

interface WalletChallenge {
  challengeId: string;
  message: string;
  expiresAt: string;
}

interface VerifyResponse {
  business: AuthenticatedBusiness;
  expiresIn: number;
}

interface AuthContextValue {
  business: AuthenticatedBusiness | null;
  isAuthenticated: boolean;
  isCheckingSession: boolean;
  isSigningIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "Authentication failed";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionQuery = useQuery({
    queryKey: ["auth-session", address?.toLowerCase()],
    queryFn: () => apiRequest<AuthenticatedBusiness>("/v1/auth/me"),
    enabled: Boolean(isConnected && address),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  const business = useMemo(() => {
    if (!address || !sessionQuery.data) return null;
    return sessionQuery.data.address.toLowerCase() === address.toLowerCase()
      ? sessionQuery.data
      : null;
  }, [address, sessionQuery.data]);

  useEffect(() => {
    if (!isConnected) {
      setError(null);
      queryClient.removeQueries({ queryKey: ["auth-session"] });
    }
  }, [isConnected, queryClient]);

  const signIn = useCallback(async () => {
    if (!address || !isConnected) {
      setError("Connect your wallet before signing in.");
      return;
    }

    setIsSigningIn(true);
    setError(null);
    try {
      const challenge = await apiRequest<WalletChallenge>(
        "/v1/auth/challenge",
        {
          method: "POST",
          json: { address },
          csrf: "omit",
        },
      );
      const signature = await signMessageAsync({ message: challenge.message });
      const verified = await apiRequest<VerifyResponse>("/v1/auth/verify", {
        method: "POST",
        json: {
          address,
          challengeId: challenge.challengeId,
          signature,
        },
        csrf: "omit",
      });
      queryClient.setQueryData(
        ["auth-session", address.toLowerCase()],
        verified.business,
      );
    } catch (authError) {
      setError(errorMessage(authError));
      throw authError;
    } finally {
      setIsSigningIn(false);
    }
  }, [address, isConnected, queryClient, signMessageAsync]);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      if (business) {
        await apiRequest("/v1/auth/logout", { method: "POST" });
      }
    } catch (logoutError) {
      // An expired server session is already effectively signed out. Always
      // clear the browser's cached identity, while retaining a useful error.
      if (!(logoutError instanceof ApiError && logoutError.status === 401)) {
        setError(errorMessage(logoutError));
      }
    } finally {
      queryClient.removeQueries({ queryKey: ["auth-session"] });
    }
  }, [business, queryClient]);

  const refreshSession = useCallback(async () => {
    if (isConnected && address) await sessionQuery.refetch();
  }, [address, isConnected, sessionQuery]);

  const value = useMemo<AuthContextValue>(
    () => ({
      business,
      isAuthenticated: Boolean(business),
      isCheckingSession: sessionQuery.isLoading,
      isSigningIn,
      error,
      signIn,
      signOut,
      refreshSession,
    }),
    [
      business,
      error,
      isSigningIn,
      refreshSession,
      sessionQuery.isLoading,
      signIn,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context)
    throw new Error("useAuth must be used within an <AuthProvider>");
  return context;
}

/** Allows isolated presentational tests to render without the app provider. */
export function useOptionalAuth(): AuthContextValue | null {
  return useContext(AuthContext);
}
