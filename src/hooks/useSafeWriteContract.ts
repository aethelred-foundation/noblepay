"use client";

import { useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { bufferGasLimit } from "@/lib/gas";

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
  const address = useAccount()?.address;

  type WCArgs = Parameters<typeof wagmi.writeContract>;
  type WCAArgs = Parameters<typeof wagmi.writeContractAsync>;
  const rawWrite = wagmi.writeContract as unknown as (p: WriteParams, o?: WCArgs[1]) => void;
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
        } as Parameters<NonNullable<typeof publicClient>["estimateContractGas"]>[0]);
        return bufferGasLimit(est);
      } catch {
        return undefined; // let the plain write surface the real failure
      }
    },
    [publicClient, address],
  );

  // Fire-and-forget: estimate asynchronously, then submit with the gas
  // limit. The caller's void-returning `writeContract(params)` contract is
  // preserved; the result surfaces via the hook's `data`/`error` as usual.
  const writeContract = useCallback(
    (params: WriteParams, options?: WCArgs[1]) => {
      void (async () => {
        const gas = await estimate(params);
        const p = gas === undefined ? params : { ...params, gas };
        return options === undefined ? rawWrite(p) : rawWrite(p, options);
      })();
    },
    [rawWrite, estimate],
  );

  const writeContractAsync = useCallback(
    async (params: WriteParams, options?: WCAArgs[1]) => {
      const gas = await estimate(params);
      const p = gas === undefined ? params : { ...params, gas };
      return options === undefined ? rawWriteAsync(p) : rawWriteAsync(p, options);
    },
    [rawWriteAsync, estimate],
  );

  return { ...wagmi, writeContract, writeContractAsync };
}
