/**
 * Business Hooks — Custom React hooks for NoblePay business operations.
 *
 * Provides typed hooks for business profile, registration, KYC status,
 * and payment limit tracking.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { useAccount } from 'wagmi';
import { CONTRACT_ADDRESSES } from '@/config/chains';
import { BUSINESS_REGISTRY_ABI } from '@/config/abis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BusinessProfile {
  id: string;
  address: string;
  licenseNumber: string;
  businessName: string;
  jurisdiction: string;
  businessType: string;
  kycStatus: 'PENDING' | 'VERIFIED' | 'SUSPENDED' | 'REVOKED' | 'EXPIRED';
  tier: 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
  complianceOfficer: string;
  contactEmail: string;
  registeredAt: number;
  lastVerified: number;
  complianceScore: number;
}

export interface BusinessLimits {
  dailyLimit: number;
  monthlyLimit: number;
  dailyUsed: number;
  monthlyUsed: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  tier: string;
}

export interface BusinessRegistrationParams {
  licenseNumber: string;
  businessName: string;
  jurisdiction: string;
  businessType: string;
  complianceOfficer: string;
  contactEmail: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// useBusinessProfile — current connected business details
// ---------------------------------------------------------------------------

export function useBusinessProfile() {
  const { address } = useAccount();

  return useQuery({
    queryKey: ['businessProfile', address],
    queryFn: () => fetchJson<BusinessProfile>(`/v1/businesses/${address}`),
    enabled: !!address,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// useBusinessRegistered — check if address is registered on-chain
// ---------------------------------------------------------------------------

export function useBusinessRegistered() {
  const { address } = useAccount();

  const { data: isRegistered } = useReadContract({
    address: CONTRACT_ADDRESSES.businessRegistry as `0x${string}`,
    abi: BUSINESS_REGISTRY_ABI,
    functionName: 'isBusinessRegistered',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !!CONTRACT_ADDRESSES.businessRegistry,
    },
  });

  return isRegistered as boolean | undefined;
}

// ---------------------------------------------------------------------------
// useBusinessRegistration — mutation for registering a new business
// ---------------------------------------------------------------------------

export function useBusinessRegistration() {
  const queryClient = useQueryClient();
  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const register = (params: BusinessRegistrationParams) => {
    writeContract({
      address: CONTRACT_ADDRESSES.businessRegistry as `0x${string}`,
      abi: BUSINESS_REGISTRY_ABI,
      functionName: 'registerBusiness',
      args: [params.licenseNumber, '0x4145' as `0x${string}`, '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`],
    });

    // Also register via API for off-chain data
    fetchJson('/v1/businesses', {
      method: 'POST',
      body: JSON.stringify(params),
    }).catch(console.error);
  };

  if (isSuccess) {
    queryClient.invalidateQueries({ queryKey: ['businessProfile'] });
  }

  return {
    register,
    txHash,
    isPending,
    isConfirming,
    isSuccess,
  };
}

// ---------------------------------------------------------------------------
// useBusinessPaymentLimits — daily/monthly limits and usage
// ---------------------------------------------------------------------------

export function useBusinessPaymentLimits() {
  const { address } = useAccount();

  return useQuery({
    queryKey: ['businessLimits', address],
    queryFn: () => fetchJson<BusinessLimits>(`/v1/businesses/${address}/limits`),
    enabled: !!address,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// useBusinessList — paginated list of all businesses (admin)
// ---------------------------------------------------------------------------

export function useBusinessList(filters?: {
  tier?: string;
  kycStatus?: string;
  jurisdiction?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.tier) params.set('tier', filters.tier);
  if (filters?.kycStatus) params.set('kycStatus', filters.kycStatus);
  if (filters?.jurisdiction) params.set('jurisdiction', filters.jurisdiction);
  if (filters?.search) params.set('search', filters.search);
  params.set('page', String(filters?.page ?? 1));
  params.set('pageSize', String(filters?.pageSize ?? 20));

  return useQuery({
    queryKey: ['businesses', filters],
    queryFn: () =>
      fetchJson<{ businesses: BusinessProfile[]; total: number }>(
        `/v1/businesses?${params.toString()}`,
      ),
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// useVerifyBusiness — verify a business KYC (compliance officer)
// ---------------------------------------------------------------------------

export function useVerifyBusiness() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (businessId: string) =>
      fetchJson(`/v1/businesses/${businessId}/verify`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['businesses'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpgradeTier — upgrade business tier
// ---------------------------------------------------------------------------

export function useUpgradeTier() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      businessId,
      newTier,
    }: {
      businessId: string;
      newTier: 'PREMIUM' | 'ENTERPRISE';
    }) =>
      fetchJson(`/v1/businesses/${businessId}/upgrade`, {
        method: 'POST',
        body: JSON.stringify({ tier: newTier }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['businesses'] });
      queryClient.invalidateQueries({ queryKey: ['businessProfile'] });
    },
  });
}
