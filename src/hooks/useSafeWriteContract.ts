"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { activeNetworkAnchor } from "@/config/chains";
import { bufferGasLimit } from "@/lib/gas";
import {
  Eip1193Provider,
  verifyPublicClientNetworkAnchor,
  verifyWalletNetworkAnchor,
} from "@/lib/network-anchor";

/**
 * Drop-in replacement for wagmi's `useWriteContract` that buffers the gas
 * limit before submitting — for BOTH `writeContract` (fire-and-forget) and
 * `writeContractAsync`.
 *
 * The Aethelred EVM's `eth_estimateGas` under-reports gas for
 * state-changing calls, so a raw wagmi write reverts out-of-gas. This
 * hook estimates the call, applies {@link bufferGasLimit}, and submits
 * that as an explicit gas limit. If the caller already set `gas`, or
 * estimation itself reverts, it falls through to the plain write so the
 * real revert reason still surfaces.
 */
type WriteParams = {
  address: `0x${string}`;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas?: bigint;
  chainId?: number;
  account?: `0x${string}`;
  [key: string]: unknown;
};

export function useSafeWriteContract() {
  const wagmi = useWriteContract();
  const publicClient = usePublicClient();
  const { address, connector } = useAccount();
  const [networkError, setNetworkError] = useState<Error | null>(null);

  type WCArgs = Parameters<typeof wagmi.writeContract>;
  type WCAArgs = Parameters<typeof wagmi.writeContractAsync>;
  const rawWrite = wagmi.writeContract as unknown as (
    p: WriteParams,
    o?: WCArgs[1],
  ) => void;
  const rawWriteAsync = wagmi.writeContractAsync as unknown as (
    p: WriteParams,
    o?: WCAArgs[1],
  ) => ReturnType<typeof wagmi.writeContractAsync>;

  const estimate = useCallback(
    async (params: WriteParams): Promise<bigint | undefined> => {
      if (params.gas !== undefined || !publicClient) return params.gas;
      try {
        const est = await publicClient.estimateContractGas({
          address: params.address,
          abi: params.abi,
          functionName: params.functionName,
          args: params.args,
          value: params.value,
          account: params.account ?? address,
        } as Parameters<
          NonNullable<typeof publicClient>["estimateContractGas"]
        >[0]);
        return bufferGasLimit(est);
      } catch {
        return undefined; // let the plain write surface the real failure
      }
    },
    [publicClient, address],
  );

  const verifySigningProvider = useCallback(async () => {
    if (!connector) {
      throw new Error("Wallet transaction blocked: no wallet is connected");
    }
    const provider = await connector.getProvider();
    if (
      !provider ||
      typeof (provider as Partial<Eip1193Provider>).request !== "function"
    ) {
      throw new Error(
        "Wallet transaction blocked: connected wallet has no EIP-1193 provider",
      );
    }
    await verifyWalletNetworkAnchor(
      provider as Eip1193Provider,
      activeNetworkAnchor,
    );
  }, [connector]);

  const prepare = useCallback(
    async (params: WriteParams): Promise<WriteParams> => {
      if (!activeNetworkAnchor || !publicClient) {
        throw new Error(
          "Wallet transaction blocked: public RPC network anchor cannot be verified",
        );
      }
      await verifyPublicClientNetworkAnchor(
        publicClient as unknown as Eip1193Provider,
        activeNetworkAnchor,
      );
      const gas = await estimate(params);
      // This is deliberately the final asynchronous preflight before the
      // wallet prompt/send. Do not replace it with the configured public RPC.
      await verifySigningProvider();
      setNetworkError(null);
      return gas === undefined ? params : { ...params, gas };
    },
    [estimate, publicClient, verifySigningProvider],
  );

  // Fire-and-forget: estimate asynchronously, then submit with the gas
  // limit. The caller's void-returning `writeContract(params)` contract is
  // preserved; the result surfaces via the hook's `data`/`error` as usual.
  const writeContract = useCallback(
    (params: WriteParams, options?: WCArgs[1]) => {
      void (async () => {
        const p = await prepare(params);
        return options === undefined ? rawWrite(p) : rawWrite(p, options);
      })().catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error("Wallet preflight failed");
        setNetworkError(normalized);
        const onError = (options as { onError?: (cause: Error) => void })
          ?.onError;
        onError?.(normalized);
      });
    },
    [rawWrite, prepare],
  );

  const writeContractAsync = useCallback(
    async (params: WriteParams, options?: WCAArgs[1]) => {
      try {
        const p = await prepare(params);
        return options === undefined
          ? rawWriteAsync(p)
          : rawWriteAsync(p, options);
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error("Wallet preflight failed");
        setNetworkError(normalized);
        throw normalized;
      }
    },
    [rawWriteAsync, prepare],
  );

  const reset = useCallback(() => {
    setNetworkError(null);
    wagmi.reset();
  }, [wagmi]);

  return {
    ...wagmi,
    error: networkError ?? wagmi.error,
    isError: networkError !== null || wagmi.isError,
    reset,
    writeContract,
    writeContractAsync,
  };
}
