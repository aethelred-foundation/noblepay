import { FormEvent, useState } from "react";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import { activeChain, CONTRACT_ADDRESSES } from "@/config/chains";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  useBusinessPaymentLimits,
  useBusinessProfile,
  useBusinessRegistered,
  useBusinessRegistration,
  type BusinessRegistrationParams,
} from "@/hooks/useBusiness";
import { Badge } from "@/components/SharedComponents";
import {
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const emptyForm: BusinessRegistrationParams = {
  licenseNumber: "",
  businessName: "",
  jurisdiction: "UAE",
  businessType: "",
  complianceOfficer: "",
  contactEmail: "",
};

function OwnBusinessProfile() {
  const profile = useBusinessProfile();
  const limits = useBusinessPaymentLimits();

  if (profile.isLoading || limits.isLoading)
    return <LoadingState label="Loading business registry profile" />;
  if (profile.error)
    return (
      <ErrorState error={profile.error} retry={() => void profile.refetch()} />
    );
  if (limits.error)
    return (
      <ErrorState error={limits.error} retry={() => void limits.refetch()} />
    );
  if (!profile.data)
    return (
      <ErrorState
        error={
          new Error("The authenticated business profile was not returned.")
        }
      />
    );

  const business = profile.data;
  return (
    <div className="space-y-6">
      {limits.data && !limits.data.mirrorInSync && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100"
        >
          The API profile tier is out of sync with BusinessRegistry. Payment
          limits below come directly from block {limits.data.blockNumber}; an
          administrator must reconcile the confirmed tier transaction before
          changing profile data.
        </div>
      )}
      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-semibold text-white">
                {business.businessName}
              </h2>
              <Badge
                variant={
                  business.kycStatus === "VERIFIED"
                    ? "success"
                    : business.kycStatus === "SUSPENDED" ||
                        business.kycStatus === "REJECTED" ||
                        business.kycStatus === "REVOKED"
                      ? "error"
                      : "warning"
                }
              >
                {business.kycStatus}
              </Badge>
              <Badge variant="neutral">{business.tier}</Badge>
            </div>
            <p className="mt-3 font-mono text-xs text-slate-500">
              {business.address}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />{" "}
            Wallet-authenticated tenant
          </div>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Daily remaining"
          value={limits.data?.daily.remaining ?? "0"}
          detail={`Limit ${limits.data?.daily.limit ?? business.dailyLimit ?? "0"}`}
        />
        <MetricCard
          label="Monthly remaining"
          value={limits.data?.monthly.remaining ?? "0"}
          detail={`Limit ${limits.data?.monthly.limit ?? business.monthlyLimit ?? "0"}`}
        />
        <MetricCard
          label="Daily used"
          value={limits.data?.daily.used ?? "0"}
          detail={
            limits.data?.daily.transactions == null
              ? "Transaction count unavailable"
              : `${limits.data.daily.transactions} transactions`
          }
        />
        <MetricCard
          label="Monthly used"
          value={limits.data?.monthly.used ?? "0"}
          detail={
            limits.data?.monthly.transactions == null
              ? "Transaction count unavailable"
              : `${limits.data.monthly.transactions} transactions`
          }
        />
      </div>

      <Panel
        title="Registry details"
        description="The tenant-scoped API profile linked to the on-chain Business Registry entry."
      >
        <dl className="grid gap-x-8 gap-y-5 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              License
            </dt>
            <dd className="mt-1 text-slate-200">{business.licenseNumber}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              Jurisdiction
            </dt>
            <dd className="mt-1 text-slate-200">{business.jurisdiction}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              Business type
            </dt>
            <dd className="mt-1 text-slate-200">{business.businessType}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              Contact
            </dt>
            <dd className="mt-1 text-slate-200">{business.contactEmail}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              Compliance officer
            </dt>
            <dd className="mt-1 break-all font-mono text-xs text-slate-300">
              {business.complianceOfficer || "Not assigned"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              Registered
            </dt>
            <dd className="mt-1 text-slate-200">
              {new Date(business.registeredAt).toLocaleString()}
            </dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}

function RegistrationForm() {
  const { wallet, addNotification } = useApp();
  const registration = useBusinessRegistration();
  const [form, setForm] = useState(emptyForm);
  const officer = form.complianceOfficer || wallet.address;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await registration.register({ ...form, complianceOfficer: officer });
      addNotification(
        "success",
        "Business registered",
        "The registry receipt was verified and the API profile was created.",
      );
    } catch (error) {
      addNotification(
        "error",
        "Registration failed",
        error instanceof Error
          ? error.message
          : "Registration could not be completed.",
      );
    }
  };

  if (registration.data) {
    return (
      <div className="space-y-6">
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6">
          <CheckCircle2 className="h-7 w-7 text-emerald-400" />
          <h2 className="mt-4 text-xl font-semibold text-emerald-100">
            Registration confirmed — verification pending
          </h2>
          <p className="mt-2 text-sm leading-6 text-emerald-100/70">
            {registration.data.business.businessName} is linked to the connected
            on-chain wallet. The independently configured Business Registry
            verifier must complete KYC on-chain before wallet sign-in or API
            access is enabled.
          </p>
        </div>
        <Panel
          title="One-time API credential"
          description="Use this only for server-to-server integrations. It will never be returned again."
        >
          <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
            <div className="flex items-start gap-3">
              <KeyRound className="mt-0.5 h-5 w-5 text-amber-300" />
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-xs text-amber-100">
                  {registration.data.apiKey}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      registration.data!.apiKey,
                    )
                  }
                  className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-amber-200 hover:text-white"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy credential
                </button>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <Panel
      title="Register this business"
      description="The wallet confirms the Business Registry transaction first; the API independently verifies that receipt before creating a profile."
    >
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <label className="text-sm text-slate-300">
          Registered business name
          <input
            required
            maxLength={255}
            value={form.businessName}
            onChange={(event) =>
              setForm({ ...form, businessName: event.target.value })
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
          />
        </label>
        <label className="text-sm text-slate-300">
          License number
          <input
            required
            minLength={6}
            maxLength={20}
            pattern={form.jurisdiction === "UAE" ? "[A-Za-z0-9-]+" : undefined}
            title={
              form.jurisdiction === "UAE"
                ? "Use 6–20 letters, numbers, or hyphens."
                : "Use 6–20 characters."
            }
            value={form.licenseNumber}
            onChange={(event) =>
              setForm({ ...form, licenseNumber: event.target.value })
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
          />
        </label>
        <label className="text-sm text-slate-300">
          Jurisdiction
          <select
            required
            value={form.jurisdiction}
            onChange={(event) =>
              setForm({
                ...form,
                jurisdiction: event.target
                  .value as BusinessRegistrationParams["jurisdiction"],
              })
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
          >
            <option value="UAE">United Arab Emirates</option>
            <option value="INTERNATIONAL">International</option>
          </select>
        </label>
        <label className="text-sm text-slate-300">
          Business type
          <input
            required
            maxLength={100}
            value={form.businessType}
            onChange={(event) =>
              setForm({ ...form, businessType: event.target.value })
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
          />
        </label>
        <label className="text-sm text-slate-300">
          Contact email
          <input
            required
            type="email"
            value={form.contactEmail}
            onChange={(event) =>
              setForm({ ...form, contactEmail: event.target.value })
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
          />
        </label>
        <label className="text-sm text-slate-300">
          Compliance officer wallet
          <input
            required
            pattern="0x[a-fA-F0-9]{40}"
            value={officer}
            onChange={(event) =>
              setForm({ ...form, complianceOfficer: event.target.value.trim() })
            }
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white"
          />
        </label>
        <div className="md:col-span-2">
          {registration.pendingRegistrationTxHash && (
            <div
              role="status"
              className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100/80"
            >
              A confirmed registry transaction is being finalized. Retrying this
              form reuses that transaction and will not register twice.{" "}
              {activeChain.blockExplorers?.default.url && (
                <a
                  href={`${activeChain.blockExplorers.default.url}/tx/${registration.pendingRegistrationTxHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 inline-flex items-center gap-1 font-semibold text-amber-200 hover:text-white"
                >
                  View receipt <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          )}
          {registration.error && (
            <p role="alert" className="mb-3 text-sm text-red-300">
              {registration.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={registration.isPending || registration.isConfirming}
            className="rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
          >
            {registration.isPending
              ? "Waiting for wallet…"
              : registration.isConfirming
                ? "Verifying registry receipt…"
                : "Register on Aethelred"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function BusinessAccess() {
  const { wallet } = useApp();
  const auth = useAuth();
  const registered = useBusinessRegistered();

  if (!wallet.connected || wallet.isWrongNetwork)
    return (
      <SessionGate>
        <span />
      </SessionGate>
    );
  if (auth.isAuthenticated) return <OwnBusinessProfile />;
  if (!CONTRACT_ADDRESSES.businessRegistry)
    return (
      <ErrorState
        error={
          new Error("Business Registry contract address is not configured.")
        }
      />
    );
  if (registered.isLoading)
    return <LoadingState label="Checking the on-chain Business Registry" />;
  if (registered.error)
    return (
      <ErrorState
        error={registered.error}
        retry={() => void registered.refetch()}
      />
    );
  if (registered.isRegistered) {
    if (registered.kycStatus === "PENDING") {
      return (
        <Panel
          title="KYC verification pending"
          description="Your Business Registry registration is confirmed. Access remains closed until the independently configured verifier submits verifyBusiness on-chain and the platform administrator reconciles that confirmed transaction."
        >
          <p className="text-sm leading-6 text-slate-300">
            No additional wallet transaction is required. Ask the verifier or
            platform operator for the verification transaction status, then
            refresh this page.
          </p>
          <button
            type="button"
            onClick={() => void registered.refetch()}
            className="mt-4 rounded-lg border border-amber-400/40 px-4 py-2 text-sm font-semibold text-amber-200 hover:bg-amber-400/10"
          >
            Refresh registry status
          </button>
        </Panel>
      );
    }
    if (
      registered.kycStatus === "SUSPENDED" ||
      registered.kycStatus === "REVOKED"
    ) {
      return (
        <ErrorState
          error={
            new Error(
              `Business Registry access is ${registered.kycStatus.toLowerCase()}. Contact the platform compliance team.`,
            )
          }
          retry={() => void registered.refetch()}
        />
      );
    }
    return (
      <SessionGate>
        <span />
      </SessionGate>
    );
  }
  return <RegistrationForm />;
}

export default function BusinessesPage() {
  return (
    <PageShell
      title="Business identity"
      description="Register and inspect the authenticated company identity used for NoblePay limits and compliance."
      path="/businesses"
    >
      <BusinessAccess />
    </PageShell>
  );
}
