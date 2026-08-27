import { ReactNode, useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { activeNetworkAnchor } from "@/config/chains";
import {
  Eip1193Provider,
  verifyPublicClientNetworkAnchor,
} from "@/lib/network-anchor";

type VerificationState = "checking" | "ready" | "failed";

/**
 * Prevent any application query from rendering before the browser-facing RPC
 * proves the immutable network anchor. Contract writes still recheck this RPC
 * and the connected wallet provider immediately before submission.
 */
export function NetworkAnchorGate({ children }: { children: ReactNode }) {
  const publicClient = usePublicClient();
  const [state, setState] = useState<VerificationState>(
    activeNetworkAnchor ? "checking" : "ready",
  );

  const verify = useCallback(async () => {
    if (!activeNetworkAnchor) {
      setState("ready");
      return;
    }
    if (!publicClient) {
      setState("failed");
      return;
    }
    setState("checking");
    try {
      await verifyPublicClientNetworkAnchor(
        publicClient as unknown as Eip1193Provider,
        activeNetworkAnchor,
      );
      setState("ready");
    } catch {
      setState("failed");
    }
  }, [publicClient]);

  useEffect(() => {
    void verify();
  }, [verify]);

  if (state === "ready") return <>{children}</>;
  if (state === "failed") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
        <section className="max-w-lg text-center" role="alert">
          <h1 className="text-2xl font-semibold">
            Network verification failed
          </h1>
          <p className="mt-3 text-slate-300">
            NoblePay has disabled chain data and transactions because the public
            RPC does not match this release&apos;s immutable network anchor.
          </p>
          <button
            className="mt-6 rounded-lg bg-brand-600 px-4 py-2 font-medium"
            onClick={() => void verify()}
            type="button"
          >
            Retry verification
          </button>
        </section>
      </main>
    );
  }
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-slate-950 text-white"
      role="status"
    >
      Verifying Aethelred network identity…
    </main>
  );
}
