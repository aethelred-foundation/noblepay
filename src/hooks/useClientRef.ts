import { useRef } from "react";
import { usePublicClient } from "wagmi";
import { activeChain } from "@/config/chains";

/**
 * Hold wagmi's public client in a ref and expose a stable readiness flag.
 *
 * wagmi returns a fresh client object on every re-render, so listing it as a
 * dependency of an effect re-fires that effect on every commit. For an effect
 * that performs an async read and guards the result with a `cancelled` flag,
 * that is worse than wasteful: each re-run's cleanup sets `cancelled = true`,
 * so a read that was about to resolve is discarded instead of committed. While
 * a page with several such hooks is still settling, the cancellations chain.
 *
 * The treasury console shipped with this bug and rendered "Proposals (0)"
 * against a treasury that held one — with the underlying event fetch
 * succeeding on every attempt. A browser probe showed the effect running three
 * times and the data never reaching state.
 *
 * Effects should therefore depend on `ready` (a boolean) plus whatever else
 * genuinely changes, and read the client from `ref.current` at call time:
 *
 * ```ts
 * const { ref: clientRef, ready } = useClientRef();
 * useEffect(() => {
 *   const publicClient = clientRef.current;
 *   if (!publicClient) return;
 *   // ...
 * }, [clientRef, ready, nonce]);
 * ```
 *
 * This does not apply to useCallback dependencies: recreating a callback is
 * harmless, because nothing is torn down when it happens.
 */
export function useClientRef() {
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const ref = useRef(publicClient);
  ref.current = publicClient;
  return { ref, ready: Boolean(publicClient) };
}
