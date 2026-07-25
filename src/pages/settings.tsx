import { FormEvent, useEffect, useState } from "react";
import {
  CheckCircle2,
  KeyRound,
  LogOut,
  Network,
  ShieldCheck,
} from "lucide-react";
import { activeChain } from "@/config/wagmi";
import { CONTRACT_ADDRESSES } from "@/config/chains";
import { useAuth } from "@/contexts/AuthContext";
import { useApp } from "@/contexts/AppContext";
import { useBusinessProfile, useUpdateBusiness } from "@/hooks/useBusiness";
import { Badge } from "@/components/SharedComponents";
import {
  ErrorState,
  LoadingState,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

interface ProfileForm {
  businessType: string;
  contactEmail: string;
}

const blank: ProfileForm = { businessType: "", contactEmail: "" };

function SettingsContent() {
  const auth = useAuth();
  const { disconnectWallet, addNotification } = useApp();
  const profile = useBusinessProfile();
  const update = useUpdateBusiness();
  const [form, setForm] = useState(blank);

  useEffect(() => {
    if (profile.data) {
      setForm({
        businessType: profile.data.businessType,
        contactEmail: profile.data.contactEmail,
      });
    }
  }, [profile.data]);

  if (profile.isLoading)
    return <LoadingState label="Loading tenant settings" />;
  if (profile.error)
    return (
      <ErrorState error={profile.error} retry={() => void profile.refetch()} />
    );
  if (!profile.data)
    return <ErrorState error={new Error("Business profile unavailable.")} />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await update.mutateAsync({ businessId: profile.data!.id, updates: form });
      addNotification(
        "success",
        "Profile updated",
        "The tenant profile changes were saved.",
      );
    } catch (error) {
      addNotification(
        "error",
        "Update failed",
        error instanceof Error
          ? error.message
          : "Profile could not be updated.",
      );
    }
  };

  const configuredContracts = Object.entries(CONTRACT_ADDRESSES);
  return (
    <div className="space-y-6">
      <Panel
        title="Business profile"
        description="Contact details are stored off-chain. The legal name and compliance officer remain governed by the on-chain Business Registry."
      >
        <dl className="mb-5 grid gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              Registered business name
            </dt>
            <dd className="mt-1 text-slate-200">{profile.data.businessName}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">
              On-chain compliance officer
            </dt>
            <dd className="mt-1 break-all font-mono text-xs text-slate-300">
              {profile.data.complianceOfficer || "Not assigned"}
            </dd>
          </div>
        </dl>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
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
          <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <p className="text-xs text-slate-500">
              KYC: {profile.data.kycStatus} · Tier: {profile.data.tier}
            </p>
            <button
              type="submit"
              disabled={update.isPending}
              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-60"
            >
              {update.isPending ? "Saving…" : "Save profile"}
            </button>
          </div>
          {update.error && (
            <p role="alert" className="text-sm text-red-300 md:col-span-2">
              {update.error.message}
            </p>
          )}
        </form>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="API credentials"
          description="Only credential metadata is returned. Secret values are never retrievable after issuance."
        >
          {profile.data.apiKeys?.length ? (
            <div className="space-y-3">
              {profile.data.apiKeys.map((key) => (
                <div
                  key={key.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 p-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <KeyRound className="h-4 w-4 shrink-0 text-slate-500" />
                    <div className="min-w-0">
                      <p className="truncate text-sm text-slate-200">
                        {key.name}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        Last used{" "}
                        {key.lastUsed
                          ? new Date(key.lastUsed).toLocaleString()
                          : "never"}
                      </p>
                    </div>
                  </div>
                  <Badge
                    variant={key.status === "ACTIVE" ? "success" : "neutral"}
                  >
                    {key.status}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              No API credential metadata was returned.
            </p>
          )}
        </Panel>

        <Panel
          title="Browser session"
          description="The HttpOnly session expires after 15 minutes and mutating requests require a CSRF token."
        >
          <div className="flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-400" />
            <div>
              <p className="font-medium text-emerald-100">
                Wallet signature authenticated
              </p>
              <p className="mt-1 break-all font-mono text-xs text-emerald-100/60">
                {auth.business?.address}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void auth.signOut().finally(disconnectWallet)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/20"
          >
            <LogOut className="h-4 w-4" /> Sign out and disconnect
          </button>
        </Panel>
      </div>

      <Panel
        title="Runtime configuration"
        description="Public chain and contract targets embedded in this production build."
      >
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-slate-800 p-3">
          <Network className="h-5 w-5 text-amber-400" />
          <div>
            <p className="text-sm font-medium text-white">{activeChain.name}</p>
            <p className="text-xs text-slate-500">Chain ID {activeChain.id}</p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {configuredContracts.map(([name, address]) => (
            <div key={name} className="rounded-lg border border-slate-800 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs capitalize text-slate-500">
                  {name.replace(/([A-Z])/g, " $1")}
                </p>
                {address ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Badge variant="error">MISSING</Badge>
                )}
              </div>
              <p
                className="mt-2 truncate font-mono text-xs text-slate-400"
                title={address || undefined}
              >
                {address || "Not configured"}
              </p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <PageShell
      title="Settings"
      description="Manage the authenticated tenant profile and session, inspect credential metadata, and verify deployed contract targets."
      path="/settings"
    >
      <SessionGate>
        <SettingsContent />
      </SessionGate>
    </PageShell>
  );
}
