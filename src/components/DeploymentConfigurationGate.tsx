import type { ReactNode } from "react";
import { AlertTriangle, ServerCog, ShieldCheck } from "lucide-react";

const IS_UNCONFIGURED_PREVIEW =
  process.env.NEXT_PUBLIC_NOBLEPAY_CONFIGURATION_STATE ===
  "unconfigured-preview";

export function DeploymentConfigurationGate({
  children,
}: {
  children: ReactNode;
}) {
  if (!IS_UNCONFIGURED_PREVIEW) return <>{children}</>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-16 text-slate-100">
      <section
        className="w-full max-w-2xl rounded-3xl border border-amber-500/25 bg-slate-900/80 p-8 shadow-2xl shadow-black/30 sm:p-10"
        role="status"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-300">
          <ServerCog className="h-6 w-6" />
        </div>
        <p className="mt-7 text-xs font-semibold uppercase tracking-[0.22em] text-amber-300">
          NoblePay deployment preview
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
          Chain activation configuration is required
        </h1>
        <p className="mt-4 text-sm leading-7 text-slate-300">
          This preview was built successfully, but payment operations are
          deliberately disabled. The operator must supply the verified
          Aethelred RPC identity, immutable network anchor, deployed contract
          addresses, API endpoints, and WalletConnect project before NoblePay
          can expose live data or request signatures.
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <ShieldCheck className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-sm font-semibold text-emerald-100">
              Fail-closed preview
            </p>
            <p className="mt-1 text-xs leading-5 text-emerald-100/65">
              No placeholder chain, contract, payment, or compliance data is
              shown.
            </p>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-300" />
            <p className="mt-3 text-sm font-semibold text-amber-100">
              Operator action pending
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-100/65">
              Production builds still reject every missing or malformed
              required value.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
