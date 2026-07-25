import { FormEvent, useMemo, useState } from "react";
import {
  Clock3,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { activeChain } from "@/config/wagmi";
import { CONTRACT_ADDRESSES } from "@/config/chains";
import { useApp } from "@/contexts/AppContext";
import {
  usePaymentChannels,
  type PaymentChannel,
} from "@/hooks/usePaymentChannels";
import {
  parseChannelStateArtifact,
  type ChannelStateType,
} from "@/lib/channel-state";
import { Badge, Modal } from "@/components/SharedComponents";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

function tokenName(address: string) {
  const entry = [
    ["USDC", CONTRACT_ADDRESSES.usdcToken],
    ["USDT", CONTRACT_ADDRESSES.usdtToken],
  ].find(
    ([, configured]) =>
      configured && configured.toLowerCase() === address.toLowerCase(),
  );
  return entry?.[0] ?? "Unsupported token";
}

function ChannelContent() {
  const { addNotification } = useApp();
  const channels = usePaymentChannels();
  const [openCreate, setOpenCreate] = useState(false);
  const [selected, setSelected] = useState<PaymentChannel | null>(null);
  const [action, setAction] = useState<"fund" | "close" | "dispute" | null>(
    null,
  );
  const [counterparty, setCounterparty] = useState("");
  const [token, setToken] = useState(
    CONTRACT_ADDRESSES.usdcToken || CONTRACT_ADDRESSES.usdtToken || "",
  );
  const [deposit, setDeposit] = useState("");
  const [challengeHours, setChallengeHours] = useState(24);
  const [fundAmount, setFundAmount] = useState("");
  const [closeMode, setCloseMode] = useState<"cooperative" | "unilateral">(
    "cooperative",
  );
  const [balanceA, setBalanceA] = useState("");
  const [balanceB, setBalanceB] = useState("");
  const [nonce, setNonce] = useState("");
  const [stateArtifact, setStateArtifact] = useState("");

  const summary = useMemo(
    () => ({
      active: channels.channels.filter(
        (channel) => channel.statusLabel === "ACTIVE",
      ).length,
      closing: channels.channels.filter(
        (channel) =>
          channel.statusLabel === "CLOSING" ||
          channel.statusLabel === "DISPUTE",
      ).length,
      totalDeposits: channels.channels.reduce(
        (sum, channel) =>
          sum +
          Number(channel.depositADisplay || 0) +
          Number(channel.depositBDisplay || 0),
        0,
      ),
    }),
    [channels.channels],
  );

  const artifactSignatures = useMemo(() => {
    try {
      const parsed = parseChannelStateArtifact(stateArtifact);
      return {
        partyA: Boolean(parsed.signatures.partyA),
        partyB: Boolean(parsed.signatures.partyB),
      };
    } catch {
      return { partyA: false, partyB: false };
    }
  }, [stateArtifact]);

  if (!channels.configured)
    return (
      <ErrorState
        error={
          new Error(
            "Payment Channels is not deployed in this environment. Configure NEXT_PUBLIC_PAYMENT_CHANNELS_ADDRESS after the verified deployment.",
          )
        }
      />
    );
  if (!channels.settlementTokensConfigured)
    return (
      <ErrorState
        error={
          new Error(
            "Payment Channels requires a configured USDC or USDT settlement token.",
          )
        }
      />
    );
  if (channels.isLoading)
    return <LoadingState label="Reading payment channels from Aethelred" />;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const hash = await channels.openChannel({
        counterparty,
        token,
        deposit,
        challengeHours,
      });
      addNotification(
        "success",
        "Channel opened",
        `Confirmed transaction ${hash.slice(0, 12)}…`,
      );
      setOpenCreate(false);
      setCounterparty("");
      setDeposit("");
    } catch (error) {
      addNotification(
        "error",
        "Channel transaction failed",
        error instanceof Error ? error.message : "Transaction failed.",
      );
    }
  };

  const executeAction = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !action) return;
    try {
      const hash =
        action === "fund"
          ? await channels.fundChannel({
              channel: selected,
              amount: fundAmount,
            })
          : action === "dispute"
            ? await channels.counterDispute({
                channel: selected,
                artifact: stateArtifact,
              })
            : await channels.closeChannel({
                channel: selected,
                artifact: stateArtifact,
                mode: closeMode,
              });
      const successTitle =
        action === "fund"
          ? "Channel funded"
          : action === "dispute"
            ? "Newer channel state submitted"
            : "Close submitted";
      addNotification(
        "success",
        successTitle,
        `Confirmed transaction ${hash.slice(0, 12)}…`,
      );
      setSelected(null);
      setAction(null);
    } catch (error) {
      addNotification(
        "error",
        "Channel transaction failed",
        error instanceof Error ? error.message : "Transaction failed.",
      );
    }
  };

  const requiredStateType = (): ChannelStateType =>
    action === "close" && closeMode === "cooperative" ? "CLOSE" : "STATE";

  const buildArtifact = async () => {
    if (!selected) return "";
    const serialized = await channels.buildStateArtifact({
      channel: selected,
      balanceA,
      balanceB,
      nonce,
      stateType: requiredStateType(),
    });
    setStateArtifact(serialized);
    return serialized;
  };

  const importArtifact = async () => {
    if (!selected) return;
    try {
      const inspected = await channels.inspectStateArtifact(
        stateArtifact,
        selected,
        requiredStateType(),
      );
      setStateArtifact(JSON.stringify(inspected.artifact, null, 2));
      setBalanceA(inspected.balanceA);
      setBalanceB(inspected.balanceB);
      setNonce(inspected.nonce);
      addNotification(
        "success",
        "State artifact verified",
        "Chain, contract, channel, balances, nonce, and any included signatures are valid.",
      );
    } catch (error) {
      addNotification(
        "error",
        "Artifact rejected",
        error instanceof Error
          ? error.message
          : "Invalid channel-state artifact.",
      );
    }
  };

  const signArtifact = async () => {
    if (!selected) return;
    try {
      const serialized = stateArtifact || (await buildArtifact());
      const signed = await channels.signStateArtifact(
        serialized,
        selected,
        requiredStateType(),
      );
      setStateArtifact(signed);
      addNotification(
        "success",
        "State signed",
        "The connected channel party's EIP-712 signature was added to the portable artifact.",
      );
    } catch (error) {
      addNotification(
        "error",
        "State signing failed",
        error instanceof Error
          ? error.message
          : "Unable to sign channel state.",
      );
    }
  };

  const copyArtifact = async () => {
    try {
      const serialized = stateArtifact || (await buildArtifact());
      await navigator.clipboard.writeText(serialized);
      addNotification(
        "success",
        "Artifact copied",
        "Share it with the counterparty for signing, then import the returned artifact.",
      );
    } catch (error) {
      addNotification(
        "error",
        "Copy failed",
        error instanceof Error ? error.message : "Clipboard access failed.",
      );
    }
  };

  const executeGuaranteedExit = async (
    mode: "cancel" | "current",
    channel: PaymentChannel,
  ) => {
    channels.reset();
    try {
      const hash =
        mode === "cancel"
          ? await channels.cancelOpenChannel(channel)
          : await channels.initiateCurrentStateClose(channel);
      addNotification(
        "success",
        mode === "cancel"
          ? "Unfunded channel refunded"
          : "Current-state challenge started",
        `Confirmed transaction ${hash.slice(0, 12)}…`,
      );
    } catch (error) {
      addNotification(
        "error",
        mode === "cancel" ? "Channel refund failed" : "Channel close failed",
        error instanceof Error ? error.message : "Transaction failed.",
      );
    }
  };

  return (
    <div className="space-y-6">
      {!channels.kycVerified && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <p className="font-medium text-amber-100">
              Channel KYC verification required
            </p>
            <p className="mt-1 text-sm leading-6 text-amber-100/60">
              The connected address is not currently active in the on-chain
              Business Registry. New channel exposure fails closed, while
              cancel, challenge, HTLC remedy, and settlement exits remain
              available for existing channels.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Channels" value={channels.channels.length} />
        <MetricCard label="Active" value={summary.active} tone="success" />
        <MetricCard
          label="Closing or disputed"
          value={summary.closing}
          tone={summary.closing ? "warning" : "neutral"}
        />
        <MetricCard
          label="Aggregate deposits"
          value={summary.totalDeposits.toLocaleString(undefined, {
            maximumFractionDigits: 6,
          })}
          detail="Across configured channel tokens"
        />
      </div>

      <Panel
        title="On-chain channels"
        description="Balances and lifecycle state are read directly from PaymentChannels.sol."
        action={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void channels.refetch()}
              className="text-slate-400 hover:text-white"
              aria-label="Refresh channels"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              disabled={!channels.kycVerified}
              onClick={() => {
                channels.reset();
                setOpenCreate(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
            >
              <Plus className="h-4 w-4" /> Open channel
            </button>
          </div>
        }
      >
        {channels.error && (
          <div className="mb-4">
            <ErrorState
              error={channels.error}
              retry={() => void channels.refetch()}
            />
          </div>
        )}
        {!channels.channels.length ? (
          <EmptyState
            title="No payment channels"
            body="Open a channel with a KYC-verified counterparty. No sample channels are displayed."
          />
        ) : (
          <div className="space-y-4">
            {channels.channels.map((channel) => {
              const fallbackExpiry =
                channel.closingAt + channel.challengePeriod;
              const challengeEnds =
                Number(channel.disputeExpiresAt ?? fallbackExpiry) * 1000;
              const challengeOpen =
                channel.statusLabel === "CLOSING" &&
                Date.now() <= challengeEnds;
              const canFinalize =
                channel.statusLabel === "CLOSING" && !challengeOpen;
              const canFund = ["OPEN", "FUNDED", "ACTIVE"].includes(
                channel.statusLabel,
              );
              const canClose =
                channel.statusLabel === "ACTIVE" ||
                channel.statusLabel === "FUNDED";
              const connected = channels.connectedAddress?.toLowerCase();
              const isParty =
                connected === channel.partyA.toLowerCase() ||
                connected === channel.partyB.toLowerCase();
              const canCancel =
                channel.statusLabel === "OPEN" &&
                channel.depositB === 0n &&
                connected === channel.partyA.toLowerCase();
              const canCurrentStateClose =
                channel.statusLabel === "ACTIVE" && isParty;

              return (
                <article
                  key={channel.channelId}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                >
                  <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            channel.statusLabel === "ACTIVE"
                              ? "success"
                              : channel.statusLabel === "CLOSING" ||
                                  channel.statusLabel === "DISPUTE"
                                ? "warning"
                                : "neutral"
                          }
                        >
                          {channel.statusLabel}
                        </Badge>
                        <span className="font-medium text-white">
                          {tokenName(channel.token)}
                        </span>
                        <span className="text-xs text-slate-500">
                          nonce {channel.nonce.toString()}
                        </span>
                      </div>
                      <p
                        className="mt-2 truncate font-mono text-xs text-slate-500"
                        title={channel.channelId}
                      >
                        {channel.channelId}
                      </p>
                      <p
                        className="mt-1 truncate font-mono text-xs text-slate-600"
                        title={channel.partyB}
                      >
                        Counterparty {channel.partyB}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {channel.tokenSymbol ? (
                        <>
                          {canFund && (
                            <button
                              type="button"
                              onClick={() => {
                                channels.reset();
                                setSelected(channel);
                                setAction("fund");
                                setFundAmount("");
                              }}
                              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-amber-400"
                            >
                              Fund
                            </button>
                          )}
                          {canClose && (
                            <button
                              type="button"
                              onClick={() => {
                                channels.reset();
                                setSelected(channel);
                                setAction("close");
                                setBalanceA(channel.balanceADisplay || "");
                                setBalanceB(channel.balanceBDisplay || "");
                                setNonce((channel.nonce + 1n).toString());
                                setStateArtifact("");
                              }}
                              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-amber-400"
                            >
                              Close
                            </button>
                          )}
                          {challengeOpen && (
                            <button
                              type="button"
                              onClick={() => {
                                channels.reset();
                                setSelected(channel);
                                setAction("dispute");
                                setBalanceA(channel.balanceADisplay || "");
                                setBalanceB(channel.balanceBDisplay || "");
                                setNonce((channel.nonce + 1n).toString());
                                setStateArtifact("");
                              }}
                              className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-300 hover:border-red-400"
                            >
                              Counter dispute
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-amber-300">
                          Funding and signed-state actions unavailable for this
                          token
                        </span>
                      )}
                      {canCancel && (
                        <button
                          type="button"
                          disabled={channels.isMutating}
                          onClick={() =>
                            void executeGuaranteedExit("cancel", channel)
                          }
                          className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-red-300 disabled:opacity-30"
                        >
                          Cancel &amp; refund
                        </button>
                      )}
                      {canCurrentStateClose && (
                        <button
                          type="button"
                          disabled={channels.isMutating}
                          onClick={() =>
                            void executeGuaranteedExit("current", channel)
                          }
                          className="rounded-lg border border-amber-500/30 px-3 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-30"
                          title="Starts the normal challenge window using the contract's current balances; no off-chain signature is required."
                        >
                          Close current state
                        </button>
                      )}
                      {channel.statusLabel === "CLOSING" && (
                        <button
                          type="button"
                          disabled={!canFinalize || channels.isMutating}
                          onClick={() =>
                            void channels
                              .finalizeClose(channel)
                              .then((hash) =>
                                addNotification(
                                  "success",
                                  "Channel finalized",
                                  hash,
                                ),
                              )
                              .catch((error) =>
                                addNotification(
                                  "error",
                                  "Finalize failed",
                                  error instanceof Error
                                    ? error.message
                                    : "Transaction failed.",
                                ),
                              )
                          }
                          className="rounded-lg border border-amber-500/30 px-3 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-30"
                        >
                          {canFinalize ? "Finalize" : "Challenge active"}
                        </button>
                      )}
                      <a
                        href={`${activeChain.blockExplorers?.default.url}/address/${CONTRACT_ADDRESSES.paymentChannels}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open channel contract in explorer"
                        className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                  </div>
                  <dl className="mt-4 grid gap-3 border-t border-slate-800 pt-4 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-slate-600">Party A deposit</dt>
                      <dd className="mt-1 font-semibold text-slate-200">
                        {channel.depositADisplay ?? "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-600">Party B deposit</dt>
                      <dd className="mt-1 font-semibold text-slate-200">
                        {channel.depositBDisplay ?? "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-600">Balance A</dt>
                      <dd className="mt-1 font-semibold text-slate-200">
                        {channel.balanceADisplay ?? "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-600">Balance B</dt>
                      <dd className="mt-1 font-semibold text-slate-200">
                        {channel.balanceBDisplay ?? "Unavailable"}
                      </dd>
                    </div>
                  </dl>
                  {channel.statusLabel === "CLOSING" && (
                    <p className="mt-3 flex items-center gap-2 text-xs text-amber-300">
                      <Clock3 className="h-4 w-4" /> Challenge ends{" "}
                      {new Date(challengeEnds).toLocaleString()}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      <Modal
        open={openCreate}
        onClose={() => !channels.isMutating && setOpenCreate(false)}
        title="Open payment channel"
      >
        <form onSubmit={create} className="space-y-4">
          <label className="block text-sm text-slate-300">
            Counterparty
            <input
              required
              pattern="0x[a-fA-F0-9]{40}"
              value={counterparty}
              onChange={(event) => setCounterparty(event.target.value.trim())}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Settlement token
            <select
              required
              value={token}
              onChange={(event) => setToken(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            >
              {CONTRACT_ADDRESSES.usdcToken && (
                <option value={CONTRACT_ADDRESSES.usdcToken}>USDC</option>
              )}
              {CONTRACT_ADDRESSES.usdtToken && (
                <option value={CONTRACT_ADDRESSES.usdtToken}>USDT</option>
              )}
            </select>
          </label>
          <label className="block text-sm text-slate-300">
            Initial deposit
            <input
              required
              inputMode="decimal"
              value={deposit}
              onChange={(event) => setDeposit(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <label className="block text-sm text-slate-300">
            Challenge hours
            <input
              required
              type="number"
              min={1}
              max={168}
              value={challengeHours}
              onChange={(event) =>
                setChallengeHours(Number(event.target.value))
              }
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <button
            type="submit"
            disabled={channels.isMutating || !token}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
          >
            {channels.isMutating ? "Confirming on-chain…" : "Approve and open"}
          </button>
        </form>
      </Modal>

      <Modal
        open={Boolean(selected && action)}
        onClose={() =>
          !channels.isMutating && (setSelected(null), setAction(null))
        }
        title={
          action === "fund"
            ? "Fund channel"
            : action === "dispute"
              ? "Counter channel dispute"
              : "Close channel"
        }
      >
        <form onSubmit={executeAction} className="space-y-4">
          {action === "fund" ? (
            <label className="block text-sm text-slate-300">
              Amount
              <input
                required
                inputMode="decimal"
                value={fundAmount}
                onChange={(event) => setFundAmount(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
          ) : (
            <>
              {action === "close" && (
                <label className="block text-sm text-slate-300">
                  Close mode
                  <select
                    value={closeMode}
                    onChange={(event) => {
                      setCloseMode(event.target.value as typeof closeMode);
                      setStateArtifact("");
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                  >
                    <option value="cooperative">
                      Cooperative (both signatures)
                    </option>
                    <option value="unilateral">
                      Unilateral (counterparty signature)
                    </option>
                  </select>
                </label>
              )}
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm text-slate-300">
                  Final balance A
                  <input
                    required
                    value={balanceA}
                    onChange={(event) => {
                      setBalanceA(event.target.value);
                      setStateArtifact("");
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                  />
                </label>
                <label className="text-sm text-slate-300">
                  Final balance B
                  <input
                    required
                    value={balanceB}
                    onChange={(event) => {
                      setBalanceB(event.target.value);
                      setStateArtifact("");
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                  />
                </label>
              </div>
              <label className="block text-sm text-slate-300">
                State nonce
                <input
                  required
                  inputMode="numeric"
                  value={nonce}
                  onChange={(event) => {
                    setNonce(event.target.value);
                    setStateArtifact("");
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                />
              </label>
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-semibold text-slate-300">
                    Portable EIP-712 state artifact
                  </span>
                  <span className="text-slate-500">
                    Party A {artifactSignatures.partyA ? "signed" : "unsigned"}{" "}
                    · Party B{" "}
                    {artifactSignatures.partyB ? "signed" : "unsigned"}
                  </span>
                </div>
                <label className="mt-3 block text-xs text-slate-400">
                  State artifact JSON
                  <textarea
                    required
                    maxLength={16_384}
                    value={stateArtifact}
                    onChange={(event) => setStateArtifact(event.target.value)}
                    placeholder="Build a state artifact, sign it, share it with the counterparty, then import the countersigned JSON."
                    className="mt-1 min-h-48 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 text-white"
                  />
                </label>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void buildArtifact().catch((error) =>
                        addNotification(
                          "error",
                          "Artifact build failed",
                          error instanceof Error
                            ? error.message
                            : "Unable to build state.",
                        ),
                      )
                    }
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300"
                  >
                    Build from balances
                  </button>
                  <button
                    type="button"
                    onClick={() => void signArtifact()}
                    className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-300"
                  >
                    Sign with wallet
                  </button>
                  <button
                    type="button"
                    onClick={() => void importArtifact()}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300"
                  >
                    Validate import
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyArtifact()}
                    className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300"
                  >
                    Copy to share
                  </button>
                </div>
              </div>
              <p className="text-xs leading-5 text-slate-500">
                The wallet prompt binds the current chain, PaymentChannels
                deployment, channel, balances, nonce, state epoch, and state
                type. Any funding, top-up, or on-chain HTLC mutation invalidates
                older artifacts. Cooperative close needs both party signatures;
                unilateral close and counter-dispute need the other party&apos;s
                signature.
              </p>
            </>
          )}
          <button
            type="submit"
            disabled={channels.isMutating}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
          >
            {channels.isMutating
              ? "Confirming on-chain…"
              : action === "fund"
                ? "Approve and fund"
                : action === "dispute"
                  ? "Submit newer state"
                  : "Submit close state"}
          </button>
        </form>
      </Modal>
    </div>
  );
}

export default function PaymentChannelsPage() {
  return (
    <PageShell
      title="Payment channels"
      description="Open, fund, dispute, and settle real bi-directional channels on Aethelred."
      path="/payment-channels"
    >
      <SessionGate>
        <ChannelContent />
      </SessionGate>
    </PageShell>
  );
}
