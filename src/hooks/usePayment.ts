import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import {
  encodePacked,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
  zeroAddress,
} from "viem";
import { NOBLEPAY_ABI } from "@/config/abis";
import { CONTRACT_ADDRESSES, TOKEN_ADDRESS_KEYS } from "@/config/chains";
import { apiRequest, apiRequestEnvelope, withQuery } from "@/lib/api";
import { useSafeWriteContract } from "./useSafeWriteContract";

const ERC20_ABI = [
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface PaymentFilter {
  status?: string;
  currency?: string;
  riskLevel?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface PaymentDetails {
  id: string;
  paymentId: string;
  sender: string;
  recipient: string;
  amount: string;
  currency: string;
  status: string;
  riskScore: number | null;
  teeAttestation: string | null;
  purposeHash?: string | null;
  initiatedAt: string;
  screenedAt?: string | null;
  settledAt?: string | null;
  blockNumber?: string | null;
  txHash?: string | null;
}

export interface PaymentStats {
  totalPayments: number;
  totalVolume: string;
  averageAmount: string;
  byStatus: Record<string, number>;
  byCurrency: Record<string, { count: number; volume: string }>;
  last24h: { count: number; volume: string };
  last7d: { count: number; volume: string };
}

export const SUPPORTED_PAYMENT_CURRENCIES = ["USDC", "USDT"] as const;
export type PaymentCurrency = (typeof SUPPORTED_PAYMENT_CURRENCIES)[number];
export const COMPLIANCE_OFFICER_ROLE = keccak256(
  toHex("COMPLIANCE_OFFICER_ROLE"),
);

export interface InitiatePaymentParams {
  recipient: string;
  amount: string;
  currency: PaymentCurrency;
  purpose: string;
}

export interface PaymentLifecycleResult {
  payment: PaymentDetails;
  method?:
    | "settlePayment"
    | "cancelPayment"
    | "refundPayment"
    | "executeSettlementRecovery";
  txHash: string;
  confirmations: number;
  chainId: string;
  replayed: boolean;
}

interface PendingPaymentReconciliation {
  txHash: `0x${string}`;
  recipient: string;
  amount: string;
  currency: PaymentCurrency;
  purposeHash: `0x${string}`;
}

const PENDING_PAYMENT_STORAGE_PREFIX = "noblepay:pending-payment";

function isPendingPaymentReconciliation(
  value: unknown,
): value is PendingPaymentReconciliation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.txHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(candidate.txHash) &&
    typeof candidate.recipient === "string" &&
    isAddress(candidate.recipient) &&
    typeof candidate.amount === "string" &&
    /^\d+(?:\.\d{1,6})?$/.test(candidate.amount) &&
    typeof candidate.currency === "string" &&
    SUPPORTED_PAYMENT_CURRENCIES.includes(
      candidate.currency as PaymentCurrency,
    ) &&
    typeof candidate.purposeHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(candidate.purposeHash)
  );
}

export function usePayment(paymentId: string | undefined) {
  return useQuery({
    queryKey: ["payment", paymentId],
    queryFn: () => apiRequest<PaymentDetails>(`/v1/payments/${paymentId}`),
    enabled: Boolean(paymentId),
    staleTime: 10_000,
  });
}

export function usePayments(filters: PaymentFilter = {}) {
  return useQuery({
    queryKey: ["payments", filters],
    queryFn: async () => {
      const response = await apiRequestEnvelope<PaymentDetails[]>(
        withQuery("/v1/payments", {
          status: filters.status,
          currency: filters.currency,
          riskLevel: filters.riskLevel,
          search: filters.search,
          from: filters.from,
          to: filters.to,
          page: filters.page ?? 1,
          limit: filters.pageSize ?? 20,
        }),
      );
      return {
        payments: response.data,
        total: response.pagination?.total ?? response.data.length,
        page: response.pagination?.page ?? filters.page ?? 1,
        totalPages: response.pagination?.totalPages ?? 1,
      };
    },
    staleTime: 5_000,
  });
}

/**
 * Submit the escrow transaction with the connected wallet, including an exact
 * ERC-20 allowance when needed, then ask the API to verify the receipt/event
 * from its own RPC before recording the payment.
 */
export function useInitiatePayment() {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useSafeWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>();
  const [pendingReconciliation, setPendingReconciliation] =
    useState<PendingPaymentReconciliation | null>(null);
  const storageKey =
    address && CONTRACT_ADDRESSES.noblepay
      ? `${PENDING_PAYMENT_STORAGE_PREFIX}:${address.toLowerCase()}:${CONTRACT_ADDRESSES.noblepay.toLowerCase()}`
      : null;

  useEffect(() => {
    setPendingReconciliation(null);
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!isPendingPaymentReconciliation(parsed)) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      setPendingReconciliation(parsed);
      setTxHash(parsed.txHash);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  const persistPending = (pending: PendingPaymentReconciliation | null) => {
    setPendingReconciliation(pending);
    if (!storageKey || typeof window === "undefined") return;
    try {
      if (pending)
        window.localStorage.setItem(storageKey, JSON.stringify(pending));
      else window.localStorage.removeItem(storageKey);
    } catch {
      // Reconciliation still works in-memory when browser storage is blocked.
    }
  };

  const reconcilePending = (pending: PendingPaymentReconciliation) =>
    apiRequest<PaymentDetails>("/v1/payments/reconcile", {
      method: "POST",
      json: pending,
    });

  const handleReconciled = (payment: PaymentDetails) => {
    persistPending(null);
    queryClient.setQueryData(["payment", payment.paymentId], payment);
    void queryClient.invalidateQueries({ queryKey: ["payments"] });
    void queryClient.invalidateQueries({ queryKey: ["paymentStats"] });
  };

  const mutation = useMutation({
    mutationFn: async (params: InitiatePaymentParams) => {
      if (!address) throw new Error("Connect the sending wallet first.");
      if (
        !SUPPORTED_PAYMENT_CURRENCIES.includes(
          params.currency as PaymentCurrency,
        )
      ) {
        throw new Error(
          "NoblePay initiation supports only 6-decimal USDC and USDT.",
        );
      }
      if (!isAddress(params.recipient))
        throw new Error("Enter a valid EVM recipient address.");
      if (params.recipient.toLowerCase() === zeroAddress) {
        throw new Error("The zero address cannot receive a payment.");
      }
      if (params.recipient.toLowerCase() === address.toLowerCase()) {
        throw new Error("The sender and recipient must be different wallets.");
      }
      if (
        !CONTRACT_ADDRESSES.noblepay ||
        !isAddress(CONTRACT_ADDRESSES.noblepay)
      ) {
        throw new Error("NoblePay contract address is not configured.");
      }
      if (!publicClient)
        throw new Error("Aethelred RPC client is unavailable.");
      if (pendingReconciliation) {
        throw new Error(
          "A confirmed payment is awaiting API reconciliation. Recover it before submitting another payment.",
        );
      }
      if (!/^\d+(?:\.\d{1,6})?$/.test(params.amount)) {
        throw new Error(
          "Enter a positive amount with no more than 6 decimal places.",
        );
      }
      const purpose = params.purpose.trim();
      if (purpose.length < 3 || purpose.length > 500) {
        throw new Error(
          "Payment purpose must contain between 3 and 500 characters.",
        );
      }

      setTxHash(undefined);
      setApprovalHash(undefined);
      const amount = parseUnits(params.amount, 6);
      if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
      const tokenKey = TOKEN_ADDRESS_KEYS[params.currency];
      const tokenAddress = CONTRACT_ADDRESSES[tokenKey];
      if (!tokenAddress || !isAddress(tokenAddress)) {
        throw new Error(`${params.currency} token address is not configured.`);
      }

      const allowance = (await publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, CONTRACT_ADDRESSES.noblepay as `0x${string}`],
      })) as bigint;
      if (allowance !== amount) {
        // Some deployed USDT implementations reject a non-zero-to-non-zero
        // allowance change. Reset first when necessary, then approve exactly
        // the escrow amount so no surplus spending authority remains.
        if (allowance > 0n) {
          const resetHash = await writeContractAsync({
            address: tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [CONTRACT_ADDRESSES.noblepay as `0x${string}`, 0n],
          });
          setApprovalHash(resetHash);
          const resetReceipt = await publicClient.waitForTransactionReceipt({
            hash: resetHash,
          });
          if (resetReceipt.status !== "success")
            throw new Error("Token allowance reset reverted.");
        }
        const hash = await writeContractAsync({
          address: tokenAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [CONTRACT_ADDRESSES.noblepay as `0x${string}`, amount],
        });
        setApprovalHash(hash);
        const approval = await publicClient.waitForTransactionReceipt({ hash });
        if (approval.status !== "success")
          throw new Error("Token approval reverted.");
      }

      const purposeHash = keccak256(encodePacked(["string"], [purpose]));
      // Both allowlisted assets are USD-denominated stablecoins. The contract
      // field is ISO-4217 bytes3, not the token ticker (USDC/USDT).
      const currencyCode = "0x555344" as const;
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
        abi: NOBLEPAY_ABI,
        functionName: "initiatePayment",
        args: [
          params.recipient,
          amount,
          tokenAddress as `0x${string}`,
          purposeHash,
          currencyCode,
        ],
        value: 0n,
      });
      setTxHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error("Payment transaction reverted.");

      const pending: PendingPaymentReconciliation = {
        txHash: hash,
        recipient: params.recipient,
        amount: params.amount,
        currency: params.currency,
        purposeHash,
      };
      persistPending(pending);
      return reconcilePending(pending);
    },
    onSuccess: handleReconciled,
  });

  const recovery = useMutation({
    mutationFn: async () => {
      if (!pendingReconciliation)
        throw new Error("There is no pending payment to reconcile.");
      return reconcilePending(pendingReconciliation);
    },
    onSuccess: handleReconciled,
  });

  return {
    initiate: mutation.mutateAsync,
    txHash,
    approvalHash,
    isPending: mutation.isPending || recovery.isPending,
    isSuccess: mutation.isSuccess,
    data: mutation.data,
    error: mutation.error,
    recoveryError: recovery.error,
    pendingReconciliation,
    recover: recovery.mutateAsync,
    reset: mutation.reset,
  };
}

export function usePaymentStats() {
  return useQuery({
    queryKey: ["paymentStats"],
    queryFn: () => apiRequest<PaymentStats>("/v1/payments/stats"),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

type PaymentLifecycleAction = "settle" | "cancel" | "refund" | "recover";

interface PaymentLifecycleParams {
  paymentId: string;
  /** Reconcile a transaction that was submitted before the browser reloaded. */
  txHash?: `0x${string}`;
}

interface PendingLifecycleReconciliation {
  paymentId: `0x${string}`;
  txHash: `0x${string}`;
}

function usePaymentLifecycle(action: PaymentLifecycleAction) {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useSafeWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [pendingReconciliation, setPendingReconciliation] =
    useState<PendingLifecycleReconciliation | null>(null);
  const storageKey =
    address && CONTRACT_ADDRESSES.noblepay
      ? `noblepay:pending-${action}:${address.toLowerCase()}:${CONTRACT_ADDRESSES.noblepay.toLowerCase()}`
      : null;

  useEffect(() => {
    setPendingReconciliation(null);
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        typeof parsed.paymentId !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(parsed.paymentId) ||
        typeof parsed.txHash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(parsed.txHash)
      ) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      const pending = parsed as unknown as PendingLifecycleReconciliation;
      setPendingReconciliation(pending);
      setTxHash(pending.txHash);
    } catch {
      window.localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  const persistPending = (pending: PendingLifecycleReconciliation | null) => {
    setPendingReconciliation(pending);
    if (!storageKey || typeof window === "undefined") return;
    try {
      if (pending)
        window.localStorage.setItem(storageKey, JSON.stringify(pending));
      else window.localStorage.removeItem(storageKey);
    } catch {
      // Keep the recovery state in-memory when browser storage is unavailable.
    }
  };

  const mutation = useMutation({
    mutationFn: async ({
      paymentId,
      txHash: existingHash,
    }: PaymentLifecycleParams) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(paymentId)) {
        throw new Error("The on-chain payment ID is invalid.");
      }
      if (existingHash && !/^0x[0-9a-fA-F]{64}$/.test(existingHash)) {
        throw new Error("The lifecycle transaction hash is invalid.");
      }
      if (
        !CONTRACT_ADDRESSES.noblepay ||
        !isAddress(CONTRACT_ADDRESSES.noblepay)
      ) {
        throw new Error("NoblePay contract address is not configured.");
      }

      if (
        pendingReconciliation &&
        pendingReconciliation.paymentId !== paymentId
      ) {
        throw new Error(
          `A confirmed ${action} transaction is awaiting API reconciliation for another payment.`,
        );
      }

      let hash = existingHash ?? pendingReconciliation?.txHash;
      if (!hash) {
        if (!publicClient)
          throw new Error("Aethelred RPC client is unavailable.");
        const functionName =
          action === "recover"
            ? "executeSettlementRecovery"
            : (`${action}Payment` as
                "settlePayment" | "cancelPayment" | "refundPayment");
        hash = await writeContractAsync({
          address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
          abi: NOBLEPAY_ABI,
          functionName,
          args: [paymentId as `0x${string}`],
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          const label =
            action === "recover"
              ? "Settlement recovery"
              : `${action[0].toUpperCase()}${action.slice(1)}`;
          throw new Error(`${label} transaction reverted.`);
        }
      }
      setTxHash(hash);
      persistPending({ paymentId: paymentId as `0x${string}`, txHash: hash });

      return apiRequest<PaymentLifecycleResult>(
        `/v1/payments/${paymentId}/${action === "recover" ? "refund" : action}`,
        {
          method: "POST",
          json: { txHash: hash },
        },
      );
    },
    onSuccess: (result) => {
      persistPending(null);
      queryClient.setQueryData(
        ["payment", result.payment.paymentId],
        result.payment,
      );
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
      void queryClient.invalidateQueries({ queryKey: ["paymentStats"] });
    },
  });

  return {
    ...mutation,
    execute: mutation.mutateAsync,
    txHash,
    pendingReconciliation,
  };
}

export function useSettlePayment() {
  return usePaymentLifecycle("settle");
}

export function useCancelPayment() {
  return usePaymentLifecycle("cancel");
}

export function useRefundPayment() {
  return usePaymentLifecycle("refund");
}

/** Execute the delayed recovery and reconcile its PaymentRefunded event. */
export function useExecuteSettlementRecovery() {
  return usePaymentLifecycle("recover");
}

export interface SettlementRecoveryRequest {
  executeAfter: bigint;
  expiresAt: bigint;
  requestedBy: `0x${string}`;
}

/**
 * Read and request the governed settlement-recovery notice for one payment.
 * The contract independently enforces the compliance-officer role, live gate
 * unavailability, 48-hour delay, and bounded execution window.
 */
export function useSettlementRecoveryRequest(paymentId: string | undefined) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useSafeWriteContract();
  const [requestHash, setRequestHash] = useState<`0x${string}` | undefined>();
  const contractConfigured = Boolean(
    CONTRACT_ADDRESSES.noblepay && isAddress(CONTRACT_ADDRESSES.noblepay),
  );
  const paymentIdValid = Boolean(
    paymentId && /^0x[0-9a-fA-F]{64}$/.test(paymentId),
  );
  const requestQuery = useReadContract({
    address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
    abi: NOBLEPAY_ABI,
    functionName: "settlementRecoveryRequests",
    args: [paymentId as `0x${string}`],
    query: {
      enabled: Boolean(contractConfigured && paymentIdValid),
      refetchInterval: 30_000,
    },
  });
  const mutation = useMutation({
    mutationFn: async () => {
      if (!paymentIdValid) {
        throw new Error("The on-chain payment ID is invalid.");
      }
      if (!contractConfigured) {
        throw new Error("NoblePay contract address is not configured.");
      }
      if (!publicClient) {
        throw new Error("Aethelred RPC client is unavailable.");
      }
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
        abi: NOBLEPAY_ABI,
        functionName: "requestSettlementRecovery",
        args: [paymentId as `0x${string}`],
      });
      setRequestHash(hash);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error("Settlement recovery request reverted.");
      }
      await requestQuery.refetch();
      return hash;
    },
  });

  const rawRequest = requestQuery.data;
  const recoveryRequest: SettlementRecoveryRequest | undefined = rawRequest
    ? {
        executeAfter: rawRequest[0],
        expiresAt: rawRequest[1],
        requestedBy: rawRequest[2],
      }
    : undefined;

  return {
    recoveryRequest,
    request: mutation.mutateAsync,
    requestHash,
    isRequesting: mutation.isPending,
    requestError: mutation.error,
    isLoading: requestQuery.isLoading,
    error: requestQuery.error,
    refetch: requestQuery.refetch,
  };
}

/** Read the contract role that gates refunds of FLAGGED escrow. */
export function useComplianceOfficerAuthorization() {
  const { address } = useAccount();
  const contractConfigured = Boolean(
    CONTRACT_ADDRESSES.noblepay && isAddress(CONTRACT_ADDRESSES.noblepay),
  );
  const query = useReadContract({
    address: CONTRACT_ADDRESSES.noblepay as `0x${string}`,
    abi: NOBLEPAY_ABI,
    functionName: "hasRole",
    args: [COMPLIANCE_OFFICER_ROLE, address ?? zeroAddress],
    query: { enabled: Boolean(address && contractConfigured) },
  });

  return {
    ...query,
    isComplianceOfficer: query.data === true,
  };
}
