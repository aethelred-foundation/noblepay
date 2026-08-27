import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowRight,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { SEOHead } from "@/components/SEOHead";
import { Footer, TopNav } from "@/components/SharedComponents";

interface PageShellProps {
  title: string;
  description: string;
  path: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function PageShell({
  title,
  description,
  path,
  eyebrow = "NoblePay operations",
  action,
  children,
}: PageShellProps) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <SEOHead title={title} description={description} path={path} />
      <TopNav activePage={path} />
      <main
        id="main-content"
        className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8"
      >
        <header className="mb-8 flex flex-col justify-between gap-5 border-b border-slate-800 pb-7 md:flex-row md:items-end">
          <div className="max-w-3xl">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-amber-400">
              {eyebrow}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {title}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              {description}
            </p>
          </div>
          {action}
        </header>
        {children}
      </main>
      <Footer />
    </div>
  );
}

export function SessionGate({ children }: { children: ReactNode }) {
  const { wallet } = useApp();
  const auth = useAuth();

  if (!wallet.connected) {
    return (
      <Callout
        icon={<WalletCards className="h-5 w-5" />}
        title="Connect the business wallet"
        body="NoblePay reads operational data only after a wallet is connected. Use the wallet control above to continue."
      />
    );
  }

  if (wallet.isWrongNetwork) {
    return (
      <Callout
        icon={<AlertCircle className="h-5 w-5" />}
        title="Switch to the configured Aethelred network"
        body="Transactions and contract reads are blocked while the connected wallet is on another chain."
      />
    );
  }

  if (auth.isCheckingSession) {
    return <LoadingState label="Checking the signed wallet session" />;
  }

  if (!auth.isAuthenticated) {
    return (
      <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6">
        <div className="flex gap-4">
          <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <h2 className="font-semibold text-amber-100">
              Wallet signature required
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-amber-100/70">
              Sign a short-lived authentication challenge before NoblePay
              exposes business, payment, or compliance records. The signature is
              off-chain and cannot move funds.
            </p>
            <button
              type="button"
              disabled={auth.isSigningIn}
              onClick={() => void auth.signIn().catch(() => undefined)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
            >
              {auth.isSigningIn ? "Waiting for wallet…" : "Sign in with wallet"}
              {!auth.isSigningIn && <ArrowRight className="h-4 w-4" />}
            </button>
            {auth.error && (
              <p role="alert" className="mt-3 text-sm text-red-300">
                {auth.error}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

interface MetricCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: MetricCardProps) {
  const tones = {
    neutral: "border-slate-800",
    success: "border-emerald-500/25",
    warning: "border-amber-500/25",
    danger: "border-red-500/25",
  };
  return (
    <section
      className={`rounded-2xl border bg-slate-900/60 p-5 ${tones[tone]}`}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="mt-3 text-2xl font-semibold tabular-nums text-white">
        {value}
      </p>
      {detail && (
        <div className="mt-2 text-xs leading-5 text-slate-400">{detail}</div>
      )}
    </section>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-800 bg-slate-900/55 ${className}`}
    >
      <div className="flex flex-col justify-between gap-3 border-b border-slate-800 px-5 py-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          {description && (
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function LoadingState({
  label = "Loading live data",
}: {
  label?: string;
}) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-3 rounded-2xl border border-slate-800 bg-slate-900/40 text-sm text-slate-400">
      <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
      {label}
    </div>
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const message =
    error instanceof Error
      ? error.message
      : "The service could not load this data.";
  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-500/25 bg-red-500/10 p-5"
    >
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" />
        <div>
          <h2 className="font-semibold text-red-100">
            Live service unavailable
          </h2>
          <p className="mt-1 text-sm leading-6 text-red-200/70">{message}</p>
          {retry && (
            <button
              type="button"
              onClick={retry}
              className="mt-3 text-sm font-semibold text-red-200 underline underline-offset-4"
            >
              Retry request
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  href,
  action,
}: {
  title: string;
  body: string;
  href?: string;
  action?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 px-6 py-10 text-center">
      <ShieldCheck className="mx-auto h-8 w-8 text-slate-600" />
      <h3 className="mt-4 font-medium text-slate-200">{title}</h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">
        {body}
      </p>
      {href && action && (
        <Link
          href={href}
          className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-amber-300 hover:text-amber-200"
        >
          {action} <ArrowRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

function Callout({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900/70 p-6">
      <div className="flex gap-4 text-slate-300">
        <span className="mt-0.5 text-amber-400">{icon}</span>
        <div>
          <h2 className="font-semibold text-white">{title}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">
            {body}
          </p>
        </div>
      </div>
    </div>
  );
}
