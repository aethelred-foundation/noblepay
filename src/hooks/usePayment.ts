/**
 * Payment Hooks — Custom React hooks for NoblePay payment operations.
 *
 * Provides typed wrappers around wagmi contract reads/writes and
 * React Query for API-backed payment data.
 */

import { useCallback, useEffect } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther, parseUnits, keccak256, encodePacked, stringToHex, zeroAddress } from 'viem';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CONTRACT_ADDRESSES, TOKEN_ADDRESS_KEYS } from '@/config/chains';
import { NOBLEPAY_ABI } from '@/config/abis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaymentFilter {
  status?: string;
  currency?: string;
  dateRange?: string;
  riskLevel?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface PaymentDetails {
  paymentId: string;
  sender: string;
  recipient: string;
  amount: string;
  currency: string;
  status: string;
  riskScore: number;
  teeAttestation: string;
  initiatedAt: number;
  settledAt?: number;
}

export interface PaymentStats {
  totalPayments: number;
  totalVolume: number;
  avgSettlementTime: number;
  compliancePassRate: number;
  flaggedCount: number;
  dailyVolume: number;
}

export interface InitiatePaymentParams {
  recipient: string;
  amount: string;
  currency: string;
  purposeHash: string;
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
// usePayment — fetch a single payment by ID
// ---------------------------------------------------------------------------

export function usePayment(paymentId: string | undefined) {
  return useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => fetchJson<PaymentDetails>(`/v1/payments/${paymentId}`),
    enabled: !!paymentId,
    staleTime: 10_000,
  });
}

// ---------------------------------------------------------------------------
// usePayments — fetch paginated, filtered payment list
// ---------------------------------------------------------------------------

export function usePayments(filters: PaymentFilter = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.currency) params.set('currency', filters.currency);
  if (filters.dateRange) params.set('dateRange', filters.dateRange);
  if (filters.riskLevel) params.set('riskLevel', filters.riskLevel);
  if (filters.search) params.set('search', filters.search);
  params.set('page', String(filters.page ?? 1));
  params.set('pageSize', String(filters.pageSize ?? 20));

  return useQuery({
    queryKey: ['payments', filters],
    queryFn: () =>
      fetchJson<{ payments: PaymentDetails[]; total: number }>(
        `/v1/payments?${params.toString()}`,
      ),
    staleTime: 5_000,
  });
}

// ---------------------------------------------------------------------------
// useInitiatePayment — mutation hook for creating new payments
// ---------------------------------------------------------------------------

export function useInitiatePayment() {
  const queryClient = useQueryClient();
  const {
    writeContract,
    data: txHash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract();
  const {
    isLoading: isConfirming,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const initiate = useCallback(
    (params: InitiatePaymentParams) => {
      const purposeHash = keccak256(
        encodePacked(['string'], [params.purposeHash]),
      );

      // AETHEL settles natively (token = address(0), escrowed via msg.value);
      // stablecoins settle via ERC-20 transferFrom and need a prior approval.
      const isNative = params.currency === 'AETHEL';
      let tokenAddress: string;
      if (isNative) {
        tokenAddress = zeroAddress;
      } else {
        const tokenKey = TOKEN_ADDRESS_KEYS[params.currency];
        tokenAddress = (tokenKey && CONTRACT_ADDRESSES[tokenKey]) || '';
        if (!tokenAddress) {
          throw new Error(
            `${params.currency} token address is not configured — set the corresponding NEXT_PUBLIC_*_TOKEN_ADDRESS at build time.`,
          );
        }
      }

      const amount = isNative
        ? parseEther(params.amount)
        : parseUnits(params.amount, 6); // USDC/USDT use 6 decimals

      // bytes3 currency code, e.g. AETHEL -> "AET", USDC -> "USD"
      const currencyCode = stringToHex(params.currency.slice(0, 3), { size: 3 });

      writeContract({
        address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
        abi: NOBLEPAY_ABI,
        functionName: 'initiatePayment',
        args: [
          params.recipient as `0x${string}`,
          amount,
          tokenAddress as `0x${string}`,
          purposeHash,
          currencyCode,
        ],
        value: isNative ? amount : undefined,
      });
    },
    [writeContract],
  );

  // Invalidate payment list cache on success
  useEffect(() => {
    if (isSuccess) {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['paymentStats'] });
    }
  }, [isSuccess, queryClient]);

  return {
    initiate,
    txHash,
    isPending,
    isConfirming,
    isSuccess,
    error: writeError ?? receiptError ?? null,
    reset,
  };
}

// ---------------------------------------------------------------------------
// useNoblePayRegistered — is the connected account past the payment gate?
// ---------------------------------------------------------------------------

/**
 * Reads NoblePay's own registeredBusinesses mapping (the initiatePayment
 * onlyRegistered gate — set by the admin via syncBusiness / the
 * register-business.mjs script). Registration does NOT carry across
 * deployments, and the node reports the resulting revert with no reason
 * data, so the UI checks explicitly before submitting.
 * Returns undefined while unknown (not connected / still loading).
 */
export function useNoblePayRegistered(): boolean | undefined {
  const { address } = useAccount();
  const { data } = useReadContract({
    address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
    abi: NOBLEPAY_ABI,
    functionName: 'registeredBusinesses',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address && !!CONTRACT_ADDRESSES.noblepay,
    },
  });
  return data as boolean | undefined;
}

// ---------------------------------------------------------------------------
// usePaymentStats — dashboard statistics
// ---------------------------------------------------------------------------

export function usePaymentStats() {
  return useQuery({
    queryKey: ['paymentStats'],
    queryFn: () => fetchJson<PaymentStats>('/v1/payments/stats'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// useCancelPayment — cancel a pending payment
// ---------------------------------------------------------------------------

export function useCancelPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (paymentId: string) =>
      fetchJson(`/v1/payments/${paymentId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useRefundPayment — refund a settled payment
// ---------------------------------------------------------------------------

export function useRefundPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (paymentId: string) =>
      fetchJson(`/v1/payments/${paymentId}/refund`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
    },
  });
}
