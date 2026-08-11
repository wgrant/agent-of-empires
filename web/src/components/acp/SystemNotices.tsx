import { useEffect, useState } from "react";

import type { RespawnState } from "../../hooks/useRespawnSession";
import type { AcpState } from "../../lib/acpTypes";
import type { AcpContext } from "./AcpRuntime";
import { SwitchAgentModal } from "./SwitchAgentModal";
import { useConnectionDiagnosticsPublisher } from "../../lib/connectionDiagnosticsContext";
import { ConnectionIncidentBubble } from "../connection/ConnectionStatusView";
import { deriveConnectionDiagnostics } from "./status/connectionStatus";

/** Owns the rate-limit recovery modal toggle and hands its opener to `children`. */
export function RateLimitRecoverySection({
  sessionId,
  currentAgent,
  onPrefill,
  children,
}: {
  sessionId: string;
  currentAgent: string | null;
  onPrefill: (text: string) => void;
  children: (renderProps: { onSwitchAgent: () => void }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children({ onSwitchAgent: () => setOpen(true) })}
      <SwitchAgentModal
        open={open}
        sessionId={sessionId}
        currentAgent={currentAgent}
        onClose={() => setOpen(false)}
        onPrefill={onPrefill}
        trigger="rate_limit"
      />
    </>
  );
}

/** The agent's rate-limit wording without transport prefixes or the trailing
 *  `{"errorKind":...}` fingerprint the connection-end path appends. */
function rateLimitWording(status: string): string {
  const text = status
    .replace(/[\s:]*\{[\s\S]*\}\s*$/, "")
    .replace(/^(?:ACP connection failed:\s*)?(?:Internal error:?\s*)?/, "")
    .trim();
  return text || "the agent did not report a reset time.";
}

export function SystemNotices({
  sessionId = "",
  status,
  serverReachability,
  lagged,
  rateLimit,
  rateLimitAutoResume,
  rateLimitRetriesExhausted,
  startupError,
  workerStopped,
  workerRestarting,
  agentUnresponsive,
  agentOrphaned,
  hasEverOpened,
  reconnecting,
  retryCount,
  retryCountdown,
  maxRetries,
  manualReconnect,
  onSwitchAgent,
  onResumeRateLimit,
  rateLimitResumeState = "idle",
  rateLimitResumeError = null,
}: {
  sessionId?: string;
  status: AcpContext["status"];
  serverReachability: AcpContext["serverReachability"];
  lagged: boolean;
  rateLimit: AcpState["rateLimit"];
  /** Omitted when unknown, in which case nothing is claimed about auto-resume. */
  rateLimitAutoResume?: boolean;
  rateLimitRetriesExhausted: boolean;
  startupError: boolean;
  workerStopped: boolean;
  workerRestarting: boolean;
  agentUnresponsive: boolean;
  agentOrphaned: boolean;
  hasEverOpened: boolean;
  reconnecting: boolean;
  retryCount: number;
  retryCountdown: number;
  maxRetries: number;
  manualReconnect: () => void;
  onSwitchAgent?: () => void;
  onResumeRateLimit?: () => void;
  rateLimitResumeState?: RespawnState;
  rateLimitResumeError?: string | null;
}) {
  const { publish, clear } = useConnectionDiagnosticsPublisher();
  const diagnostics = deriveConnectionDiagnostics({
    status,
    serverReachability,
    lagged,
    rateLimit,
    rateLimitRetriesExhausted,
    hasEverOpened,
    reconnecting,
    retryCount,
    retryCountdown,
    maxRetries,
    rateLimitText: (limit) => {
      const reset = limit.resets_at === null ? null : new Date(limit.resets_at);
      return reset && !Number.isNaN(reset.getTime())
        ? `Rate-limited (${limit.kind}); resets at ${reset.toLocaleTimeString()}.`
        : `Rate-limited (${limit.kind}); ${rateLimitWording(limit.status)}`;
    },
    startupError,
    workerStopped,
    workerRestarting,
    agentUnresponsive,
    agentOrphaned,
  });
  useEffect(() => {
    publish({ sessionId, kind: "structured", diagnostics, onReconnect: manualReconnect });
  }, [diagnostics, manualReconnect, publish, sessionId]);
  useEffect(() => () => clear(sessionId), [clear, sessionId]);
  if (!diagnostics.hasIncident) return null;
  const resumePending = rateLimitResumeState === "retrying" || rateLimitResumeState === "ok";
  const actions =
    rateLimit || rateLimitRetriesExhausted ? (
      <>
          {rateLimit && onResumeRateLimit && (
            <button
              type="button"
              onClick={onResumeRateLimit}
              disabled={resumePending}
              className="rounded-md border border-brand-700 bg-brand-900/40 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-brand-100 hover:bg-brand-900/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {rateLimitResumeState === "retrying"
                ? "Resuming…"
                : rateLimitResumeState === "ok"
                  ? "Resume requested"
                  : "Resume now"}
            </button>
          )}
          {rateLimit && onSwitchAgent && (
            <button
              type="button"
              onClick={onSwitchAgent}
              className="rounded-md border border-brand-700 bg-brand-900/40 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-brand-100 hover:bg-brand-900/60"
            >
              Continue in another agent
            </button>
          )}
        {rateLimitAutoResume === true && !rateLimitRetriesExhausted && (
          <span className="basis-full text-xs text-text-muted">
            Auto-resume is armed; the session resumes when the window clears.
          </span>
        )}
        {rateLimitAutoResume === false && (
          <span className="basis-full text-xs text-text-muted">
            Auto-resume is off for this profile; use Resume now, or enable acp.rate_limit_auto_resume.
          </span>
        )}
        {rateLimitRetriesExhausted && (
          <span className="basis-full text-xs text-status-warning">
            Auto-resume stopped after repeated attempts. Resume manually or send a new prompt.
          </span>
        )}
        {rateLimitResumeState === "ok" && (
          <span className="basis-full text-xs text-text-muted">
            Resume requested. New events should start streaming shortly.
          </span>
        )}
        {rateLimitResumeState === "failed" && rateLimitResumeError && (
          <span className="basis-full text-xs text-status-error">Resume failed: {rateLimitResumeError}</span>
        )}
      </>
    ) : undefined;
  return (
    <>
      <div className="h-11 shrink-0" aria-hidden="true" />
      <ConnectionIncidentBubble diagnostics={diagnostics} onReconnect={manualReconnect} actions={actions} />
    </>
  );
}
