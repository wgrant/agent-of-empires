import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

import type { RespawnState } from "../../hooks/useRespawnSession";
import type { AcpState } from "../../lib/acpTypes";
import type { AcpContext } from "./AcpRuntime";
import { SwitchAgentModal } from "./SwitchAgentModal";
import { useConnectionDiagnosticsPublisher } from "../../lib/connectionDiagnosticsContext";
import { ConnectionIncidentBubble } from "../connection/ConnectionStatusView";
import {
  deriveConnectionDiagnostics,
  selectConnectionDiagnostics,
  type ConnectionDiagnostics,
  type ConnectionStatusSnapshot,
  type ConnectionStatusInput,
  type SessionConnectionDiagnostics,
} from "./status/connectionStatus";
import type { ConversationSyncStatus } from "./status/conversationSyncStatus";
import type { ConversationStatus } from "./status/conversationStatus";

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
  lastWebSocketOpenAt,
  lastServerMessageAt,
  lastTransportDiagnostic,
  reconnectingSince,
  liveUpdatesStale,
  conversationSync = "idle",
  conversationStatus,
  hasEverOpened,
  reconnecting,
  retryCount,
  retryCountdown,
  maxRetries,
  manualReconnect,
  diagnostics: suppliedDiagnostics,
  sessionConnection,
  connectionSnapshot,
  showConnectionIncident = true,
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
  lastWebSocketOpenAt: AcpContext["lastWebSocketOpenAt"];
  lastServerMessageAt: AcpContext["lastServerMessageAt"];
  lastTransportDiagnostic: AcpContext["lastTransportDiagnostic"];
  reconnectingSince: AcpContext["reconnectingSince"];
  liveUpdatesStale: AcpContext["liveUpdatesStale"];
  conversationSync?: ConversationSyncStatus;
  conversationStatus?: ConversationStatus;
  hasEverOpened: boolean;
  reconnecting: boolean;
  retryCount: number;
  retryCountdown: number;
  maxRetries: number;
  manualReconnect: () => void;
  diagnostics?: ConnectionDiagnostics;
  sessionConnection?: SessionConnectionDiagnostics;
  connectionSnapshot?: ConnectionStatusSnapshot;
  showConnectionIncident?: boolean;
  onSwitchAgent?: () => void;
  onResumeRateLimit?: () => void;
  rateLimitResumeState?: RespawnState;
  rateLimitResumeError?: string | null;
}) {
  const diagnostics =
    suppliedDiagnostics ??
    deriveStructuredConnectionDiagnostics({
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
      startupError,
      workerStopped,
      workerRestarting,
      agentUnresponsive,
      agentOrphaned,
      lastWebSocketOpenAt,
      lastServerMessageAt,
      lastTransportDiagnostic,
      reconnectingSince,
      liveUpdatesStale,
    });
  const effectiveSessionConnection: SessionConnectionDiagnostics = sessionConnection ?? {
    kind: "structured",
    sessionId,
    diagnostics,
    transport: {
      route: diagnostics.route,
      connectedAt: null,
      lastMessageAt: null,
      reconnectingSince: null,
      retryCount: diagnostics.retryCount ?? 0,
      retryCountdown: 0,
      maxRetries: diagnostics.maxRetries ?? 0,
      lastFailure: null,
    },
  };
  const effectiveSnapshot: ConnectionStatusSnapshot = connectionSnapshot ?? {
    dashboard: { phase: "checking", lastSuccessAt: null, failureSince: null },
    session: effectiveSessionConnection,
  };
  const displayDiagnostics = selectConnectionDiagnostics(effectiveSnapshot);
  const initialSessionLoad = conversationSync === "initial";
  const publication = (
    <PublishedConnectionDiagnostics
      sessionId={sessionId}
      sessionConnection={effectiveSessionConnection}
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
  const rateLimitIncident =
    conversationStatus?.kind === "blocked" && conversationStatus.cause === "rate_limited"
      ? true
      : rateLimit !== null && diagnostics.session === "rate_limited";
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
        <ConnectionIncidentBubble snapshot={effectiveSnapshot} onReconnect={manualReconnect} actions={actions} />
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
