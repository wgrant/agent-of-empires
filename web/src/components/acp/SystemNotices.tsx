import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

import type { RespawnState } from "../../hooks/useRespawnSession";
import type { AcpState } from "../../lib/acpTypes";
import { SwitchAgentModal } from "./SwitchAgentModal";
import { useConnectionDiagnosticsPublisher } from "../../lib/connectionDiagnosticsContext";
import { ConnectionIncidentBubble } from "../connection/ConnectionStatusView";
import {
  deriveConnectionDiagnostics,
  selectConnectionDiagnostics,
  type ConnectionStatusSnapshot,
  type ConnectionStatusInput,
  type SessionConnectionDiagnostics,
} from "./status/connectionStatus";
import type { ConversationSyncStatus } from "./status/conversationSyncStatus";

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

export function deriveStructuredConnectionDiagnostics(input: Omit<ConnectionStatusInput, "rateLimitText">) {
  return deriveConnectionDiagnostics({
    ...input,
    rateLimitText: (limit) => {
      const reset = limit.resets_at === null ? null : new Date(limit.resets_at);
      return reset && !Number.isNaN(reset.getTime())
        ? `Rate-limited (${limit.kind}); resets at ${reset.toLocaleTimeString()}.`
        : `Rate-limited (${limit.kind}); ${rateLimitWording(limit.status)}`;
    },
  });
}

export function SystemNotices({
  connectionSnapshot,
  rateLimit,
  rateLimitAutoResume,
  rateLimitRetriesExhausted,
  conversationSync = "idle",
  manualReconnect,
  showConnectionIncident = true,
  onSwitchAgent,
  onResumeRateLimit,
  rateLimitResumeState = "idle",
  rateLimitResumeError = null,
}: {
  connectionSnapshot: ConnectionStatusSnapshot & { session: SessionConnectionDiagnostics };
  rateLimit: AcpState["rateLimit"];
  /** Omitted when unknown, in which case nothing is claimed about auto-resume. */
  rateLimitAutoResume?: boolean;
  rateLimitRetriesExhausted: boolean;
  conversationSync?: ConversationSyncStatus;
  manualReconnect: () => void;
  showConnectionIncident?: boolean;
  onSwitchAgent?: () => void;
  onResumeRateLimit?: () => void;
  rateLimitResumeState?: RespawnState;
  rateLimitResumeError?: string | null;
}) {
  const displayDiagnostics = selectConnectionDiagnostics(connectionSnapshot);
  const sessionConnection = connectionSnapshot.session;
  const sessionId = sessionConnection.sessionId;
  const initialSessionLoad = conversationSync === "initial";
  const publication = (
    <PublishedConnectionDiagnostics
      sessionId={sessionId}
      sessionConnection={sessionConnection}
      onReconnect={manualReconnect}
      incidentVisible={showConnectionIncident}
    />
  );
  if (initialSessionLoad) {
    return (
      <>
        {publication}
        <InitialConversationLoadNotice />
      </>
    );
  }
  const rateLimitIncident = rateLimit !== null && displayDiagnostics.session === "rate_limited";
  const resumePending = rateLimitResumeState === "retrying" || rateLimitResumeState === "ok";
  const actions =
    rateLimitIncident || rateLimitRetriesExhausted ? (
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
      {publication}
      {showConnectionIncident && displayDiagnostics.hasIncident && (
        <ConnectionIncidentBubble snapshot={connectionSnapshot} onReconnect={manualReconnect} actions={actions} />
      )}
    </>
  );
}

function PublishedConnectionDiagnostics({
  sessionId,
  sessionConnection,
  onReconnect,
  incidentVisible,
}: {
  sessionId: string;
  sessionConnection: SessionConnectionDiagnostics;
  onReconnect: () => void;
  incidentVisible: boolean;
}) {
  const { publish, clear } = useConnectionDiagnosticsPublisher();
  useEffect(() => {
    publish({ session: sessionConnection, incidentVisible, onReconnect });
    return () => clear(sessionId);
  }, [clear, incidentVisible, onReconnect, publish, sessionConnection, sessionId]);
  return null;
}

function InitialConversationLoadNotice() {
  return <ConversationLoadingBubble />;
}

function ConversationLoadingBubble() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3" role="status">
      <div className="flex items-center gap-2 rounded-full border border-surface-700 bg-surface-850/95 px-3 py-1.5 text-xs text-text-secondary shadow-lg backdrop-blur-sm">
        <RotateCcw className="size-3 animate-spin text-text-muted" aria-hidden="true" />
        Loading conversation…
      </div>
    </div>
  );
}
