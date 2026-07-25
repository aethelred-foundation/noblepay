import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSignMessage,
} from "wagmi";
import { getAddress, isAddress } from "viem";
import { BUSINESS_REGISTRY_ABI } from "@/config/abis";
import { CONTRACT_ADDRESSES } from "@/config/chains";
import { useOptionalAuth } from "@/contexts/AuthContext";
import { apiRequest, apiRequestEnvelope, withQuery } from "@/lib/api";
import { useSafeWriteContract } from "./useSafeWriteContract";

export type BusinessKycStatus =
  | "UNVERIFIED"
  | "PENDING"
  | "VERIFIED"
  | "REJECTED"
  | "EXPIRED"
  | "SUSPENDED"
  | "REVOKED";

export type BusinessTier = "STANDARD" | "PREMIUM" | "ENTERPRISE";

export interface BusinessProfile {
  id: string;
  address: string;
  licenseNumber: string;
  businessName: string;
  jurisdiction: string;
  businessType: string;
  kycStatus: BusinessKycStatus;
  tier: BusinessTier;
  complianceOfficer?: string | null;
  contactEmail: string;
  registeredAt: string;
  lastVerified?: string | null;
  dailyLimit?: string;
  monthlyLimit?: string;
  apiKeys?: Array<{
    id: string;
    name: string;
    lastUsed: string | null;
    status: string;
    createdAt: string;
  }>;
}

export interface BusinessLimits {
  tier: BusinessTier;
  mirrorInSync: boolean;
  source: "onchain";
  chainId: string;
  blockNumber: string;
  daily: {
    epoch: string;
    limit: string;
    used: string;
    remaining: string;
    transactions: number | null;
  };
  monthly: {
    epoch: string;
    epochKind: "30-day";
    limit: string;
    used: string;
    remaining: string;
    transactions: number | null;
  };
}

export interface BusinessRegistrationParams {
  licenseNumber: string;
  businessName: string;
  jurisdiction: "UAE" | "INTERNATIONAL";
  businessType: string;
  complianceOfficer: string;
  contactEmail: string;
}

export function useBusinessProfile() {
  const auth = useOptionalAuth();
  const businessId = auth?.business?.id;

  return useQuery({
    queryKey: ["businessProfile", businessId],
    queryFn: () => apiRequest<BusinessProfile>(`/v1/businesses/${businessId}`),
    enabled: Boolean(businessId),
    staleTime: 30_000,
  });
}

export function useBusinessRegistered() {
  const { address } = useAccount();
  const { data, refetch, error, isLoading } = useReadContract({
    address: CONTRACT_ADDRESSES.businessRegistry as `0x${string}`,
    abi: BUSINESS_REGISTRY_ABI,
    functionName: "businesses",
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(address && CONTRACT_ADDRESSES.businessRegistry),
    },
  });

  const registeredAt = Array.isArray(data) ? (data[6] as bigint) : undefined;
  const isRegistered =
    registeredAt === undefined ? undefined : registeredAt !== 0n;
  const chainStatus = Array.isArray(data) ? Number(data[4]) : undefined;
  const kycStatus =
    isRegistered && chainStatus !== undefined
      ? (["PENDING", "VERIFIED", "SUSPENDED", "REVOKED"] as const)[chainStatus]
      : undefined;
  return {
    isRegistered,
    kycStatus,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Register on-chain first, wait for finality, then persist the matching API
 * profile. This prevents the API from claiming a business exists when its
 * registry transaction reverted.
 */
export function useBusinessRegistration() {
  const queryClient = useQueryClient();
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useSafeWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const storageKey =
    address && CONTRACT_ADDRESSES.businessRegistry
      ? `noblepay:pending-registration:${address.toLowerCase()}:${CONTRACT_ADDRESSES.businessRegistry.toLowerCase()}`
      : null;

  useEffect(() => {
    setTxHash(undefined);
    if (!storageKey || typeof window === "undefined") return;
    try {
      const pending = window.localStorage.getItem(storageKey);
      if (pending && /^0x[0-9a-fA-F]{64}$/.test(pending)) {
        setTxHash(pending as `0x${string}`);
      } else if (pending) {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // Recovery remains available for the current render when storage is blocked.
    }
  }, [storageKey]);

  const persistTransaction = (hash?: `0x${string}`) => {
    setTxHash(hash);
    if (!storageKey || typeof window === "undefined") return;
    try {
      if (hash) window.localStorage.setItem(storageKey, hash);
      else window.localStorage.removeItem(storageKey);
    } catch {
      // The in-memory hash still prevents a duplicate submission this session.
    }
  };

  const mutation = useMutation({
    mutationFn: async (params: BusinessRegistrationParams) => {
      if (!address)
        throw new Error("Connect the business wallet before registration.");
      if (
        !CONTRACT_ADDRESSES.businessRegistry ||
        !isAddress(CONTRACT_ADDRESSES.businessRegistry)
      ) {
        throw new Error(
          "Business Registry contract address is not configured.",
        );
      }
      if (!publicClient)
        throw new Error("Aethelred RPC client is unavailable.");
      if (!isAddress(params.complianceOfficer)) {
        throw new Error("Enter a valid compliance officer wallet address.");
      }

      const licenseNumber = params.licenseNumber.trim();
      const businessName = params.businessName.trim();
      const businessType = params.businessType.trim();
      const contactEmail = params.contactEmail.trim().toLowerCase();
      const complianceOfficer = getAddress(params.complianceOfficer);
      const licenseByteLength = new TextEncoder().encode(licenseNumber).length;
      if (licenseByteLength < 6 || licenseByteLength > 20) {
        throw new Error("License number must be between 6 and 20 bytes.");
      }
      if (
        params.jurisdiction === "UAE" &&
        !/^[A-Za-z0-9-]+$/.test(licenseNumber)
      ) {
        throw new Error(
          "UAE license numbers may contain only letters, numbers, and hyphens.",
        );
      }
      if (new TextEncoder().encode(businessName).length === 0) {
        throw new Error("Enter the registered business name.");
      }

      const jurisdiction = params.jurisdiction === "INTERNATIONAL" ? 1 : 0;
      let hash = txHash;
      if (!hash) {
        hash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.businessRegistry as `0x${string}`,
          abi: BUSINESS_REGISTRY_ABI,
          functionName: "registerBusiness",
          args: [licenseNumber, businessName, jurisdiction, complianceOfficer],
        });
        setTxHash(hash);

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          setTxHash(undefined);
          throw new Error("Business registration transaction reverted.");
        }
        persistTransaction(hash);
      }

      const challenge = await apiRequest<{
        challengeId: string;
        message: string;
        purpose: "registration";
        txHash: string;
        registrationCommitment: string;
        expiresAt: string;
      }>("/v1/auth/challenge", {
        method: "POST",
        json: {
          address,
          purpose: "registration",
          txHash: hash,
          registration: {
            licenseNumber,
            businessName,
            jurisdiction: params.jurisdiction,
            businessType,
            complianceOfficer,
            contactEmail,
          },
        },
        csrf: "omit",
      });
      const signature = await signMessageAsync({ message: challenge.message });

      return apiRequest<{
        business: BusinessProfile;
        apiKey: string;
        replayed: boolean;
        confirmations: number;
        chainId: string;
      }>("/v1/businesses", {
        method: "POST",
        json: {
          licenseNumber,
          businessName,
          jurisdiction: params.jurisdiction,
          businessType,
          complianceOfficer,
          contactEmail,
          address,
          txHash: hash,
          challengeId: challenge.challengeId,
          signature,
        },
        csrf: "omit",
      });
    },
    onSuccess: () => {
      persistTransaction(undefined);
      void queryClient.invalidateQueries({ queryKey: ["businessProfile"] });
      void queryClient.invalidateQueries({ queryKey: ["auth-session"] });
    },
  });

  return {
    register: mutation.mutateAsync,
    txHash,
    isPending: mutation.isPending && !txHash,
    isConfirming: mutation.isPending && Boolean(txHash),
    isSuccess: mutation.isSuccess,
    data: mutation.data,
    error: mutation.error,
    pendingRegistrationTxHash: txHash,
    reset: mutation.reset,
  };
}

export function useBusinessPaymentLimits() {
  const auth = useOptionalAuth();
  const businessId = auth?.business?.id;

  return useQuery({
    queryKey: ["businessLimits", businessId],
    queryFn: () =>
      apiRequest<BusinessLimits>(`/v1/businesses/${businessId}/limits`),
    enabled: Boolean(businessId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export interface BusinessListFilters {
  tier?: string;
  kycStatus?: string;
  jurisdiction?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function useBusinessList(filters: BusinessListFilters = {}) {
  return useQuery({
    queryKey: ["businesses", filters],
    queryFn: async () => {
      const response = await apiRequestEnvelope<BusinessProfile[]>(
        withQuery("/v1/businesses", {
          tier: filters.tier,
          kycStatus: filters.kycStatus,
          jurisdiction: filters.jurisdiction,
          search: filters.search,
          page: filters.page ?? 1,
          limit: filters.pageSize ?? 20,
        }),
      );
      return {
        businesses: response.data,
        total: response.pagination?.total ?? response.data.length,
      };
    },
    staleTime: 15_000,
  });
}

export interface BusinessRegistryAdminParams {
  businessId: string;
  businessAddress: string;
  txHash?: `0x${string}`;
}

export interface BusinessRegistryUpgradeParams extends BusinessRegistryAdminParams {
  newTier: "PREMIUM" | "ENTERPRISE";
}

export interface BusinessRegistryMutationResult {
  business: BusinessProfile;
  replayed: boolean;
  txHash: string;
  confirmations: number;
  chainId: string;
}

interface PendingBusinessAdminReconciliation {
  businessId: string;
  businessAddress: `0x${string}`;
  txHash: `0x${string}`;
  newTier?: "PREMIUM" | "ENTERPRISE";
}

function isPendingBusinessAdminReconciliation(
  value: unknown,
): value is PendingBusinessAdminReconciliation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.businessId === "string" &&
    candidate.businessId.length > 0 &&
    typeof candidate.businessAddress === "string" &&
    isAddress(candidate.businessAddress) &&
    typeof candidate.txHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(candidate.txHash) &&
    (candidate.newTier === undefined ||
      candidate.newTier === "PREMIUM" ||
      candidate.newTier === "ENTERPRISE")
  );
}

function useBusinessRegistryAdminAction(action: "verify" | "upgrade") {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useSafeWriteContract();
  const [pendingReconciliation, setPendingReconciliation] =
    useState<PendingBusinessAdminReconciliation | null>(null);
  const storageKey =
    address && CONTRACT_ADDRESSES.businessRegistry
      ? `noblepay:pending-business-${action}:${address.toLowerCase()}:${CONTRACT_ADDRESSES.businessRegistry.toLowerCase()}`
      : null;

  useEffect(() => {
    setPendingReconciliation(null);
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!isPendingBusinessAdminReconciliation(parsed)) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setPendingReconciliation(parsed);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  const persistPending = (
    pending: PendingBusinessAdminReconciliation | null,
  ) => {
    setPendingReconciliation(pending);
    if (!storageKey || typeof window === "undefined") return;
    try {
      if (pending)
        window.localStorage.setItem(storageKey, JSON.stringify(pending));
      else window.localStorage.removeItem(storageKey);
    } catch {
      // Keep recovery information in memory when browser storage is blocked.
    }
  };

  const mutation = useMutation({
    mutationFn: async (
      params: BusinessRegistryAdminParams | BusinessRegistryUpgradeParams,
    ) => {
      if (
        !CONTRACT_ADDRESSES.businessRegistry ||
        !isAddress(CONTRACT_ADDRESSES.businessRegistry)
      ) {
        throw new Error(
          "Business Registry contract address is not configured.",
        );
      }
      if (!isAddress(params.businessAddress)) {
        throw new Error("The business wallet address is invalid.");
      }
      if (params.txHash && !/^0x[0-9a-fA-F]{64}$/.test(params.txHash)) {
        throw new Error("The Business Registry transaction hash is invalid.");
      }

      const newTier =
        action === "upgrade"
          ? (params as BusinessRegistryUpgradeParams).newTier
          : undefined;
      if (
        action === "upgrade" &&
        !["PREMIUM", "ENTERPRISE"].includes(newTier || "")
      ) {
        throw new Error("Select the PREMIUM or ENTERPRISE target tier.");
      }
      if (
        pendingReconciliation &&
        (pendingReconciliation.businessId !== params.businessId ||
          pendingReconciliation.businessAddress.toLowerCase() !==
            params.businessAddress.toLowerCase() ||
          pendingReconciliation.newTier !== newTier)
      ) {
        throw new Error(
          `A confirmed business ${action} transaction is awaiting API reconciliation.`,
        );
      }

      let hash = params.txHash ?? pendingReconciliation?.txHash;
      if (!hash) {
        if (action === "verify") {
          throw new Error(
            "Submit verifyBusiness from the independently configured BUSINESS_VERIFIER_ADDRESS, then provide its confirmed transaction hash for reconciliation.",
          );
        }
        if (!publicClient)
          throw new Error("Aethelred RPC client is unavailable.");
        hash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.businessRegistry as `0x${string}`,
          abi: BUSINESS_REGISTRY_ABI,
          functionName: "upgradeTier",
          args: [
            params.businessAddress as `0x${string}`,
            newTier === "ENTERPRISE" ? 2 : 1,
          ],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`Business ${action} transaction reverted.`);
        }
      }

      const pending: PendingBusinessAdminReconciliation = {
        businessId: params.businessId,
        businessAddress: params.businessAddress as `0x${string}`,
        txHash: hash,
        ...(newTier ? { newTier } : {}),
      };
      persistPending(pending);
      return apiRequest<BusinessRegistryMutationResult>(
        `/v1/businesses/${params.businessId}/${action}`,
        {
          method: "POST",
          json:
            action === "upgrade" ? { txHash: hash, newTier } : { txHash: hash },
        },
      );
    },
    onSuccess: (result) => {
      persistPending(null);
      queryClient.setQueryData(
        ["businessProfile", result.business.id],
        result.business,
      );
      void queryClient.invalidateQueries({ queryKey: ["businesses"] });
      void queryClient.invalidateQueries({ queryKey: ["businessProfile"] });
      void queryClient.invalidateQueries({ queryKey: ["businessLimits"] });
    },
  });

  return { ...mutation, execute: mutation.mutateAsync, pendingReconciliation };
}

export function useVerifyBusiness() {
  return useBusinessRegistryAdminAction("verify");
}

export function useUpgradeTier() {
  return useBusinessRegistryAdminAction("upgrade");
}

export function useUpdateBusiness() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      businessId,
      updates,
    }: {
      businessId: string;
      updates: Pick<BusinessProfile, "businessType" | "contactEmail">;
    }) =>
      apiRequest<BusinessProfile>(`/v1/businesses/${businessId}`, {
        method: "PATCH",
        json: updates,
      }),
    onSuccess: (business) => {
      queryClient.setQueryData(["businessProfile", business.id], business);
      void queryClient.invalidateQueries({ queryKey: ["auth-session"] });
    },
  });
}
