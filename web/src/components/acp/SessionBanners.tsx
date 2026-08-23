import { useEffect, useState } from "react";
import { Clock, Eye } from "lucide-react";

import { useRespawnSession, type RespawnState } from "../../hooks/useRespawnSession";
import type { AcpState } from "../../lib/acpTypes";
import type { SessionStatus } from "../../lib/types";
import type { ConnectionStatusSnapshot } from "./status/connectionStatus";
import {
  deriveSessionIncident,
  type ConversationDiagnosticsSnapshot,
  type SessionIncident,
} from "./status/conversationDiagnostics";
import { deriveSessionDiagnostics, type PendingAgentOperation } from "./status/sessionDiagnostics";
import { ActionFeedbackNotice } from "./status/ActionFeedbackNotice";
import { LifecycleIncidentNotice, type LifecycleNoticeAction } from "./status/LifecycleIncidentNotice";
import { ConversationNextStepNotice } from "./status/ConversationNextStepNotice";
import { StartupErrorBanner } from "./StartupErrorBanner";
import { rateLimitDetail, RateLimitRecoverySection } from "./SystemNotices";

/** Worker lifecycle and triage banners stacked above the transcript. */
export function SessionBanners({
  sessionId,
  state,
  connectionSnapshot,
  acpWorkerState,
  trashedAt,
  archivedAt,
  snoozedUntil,
  sessionStatus,
  lastError,
  pendingOperation,
  dormant,
  currentAgent,
  rateLimitAutoResume,
  onRecoveryPrefill,
  onRestore,
  onUnarchive,
  onUnsnooze,
  dismissError,
}: {
  sessionId: string;
  state: AcpState;
  connectionSnapshot: ConnectionStatusSnapshot;
  acpWorkerState: "absent" | "resuming" | "running" | "stopping";
  trashedAt: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
  sessionStatus: SessionStatus;
  lastError: string | null;
  pendingOperation: PendingAgentOperation | null;
  dormant: boolean;
  currentAgent: string | null;
  rateLimitAutoResume?: boolean;
  onRecoveryPrefill: (text: string) => void;
  onRestore?: () => Promise<boolean> | void;
  onUnarchive?: () => Promise<boolean> | void;
  onUnsnooze?: () => Promise<boolean> | void;
  dismissError: () => void;
}) {
  const diagnostics = deriveSessionDiagnostics({
    state,
    workerState: acpWorkerState,
    sessionStatus,
    lastError,
    pendingOperation,
    dormant,
    trashedAt,
    archivedAt,
    snoozedUntil,
  });
  const conversationDiagnostics: ConversationDiagnosticsSnapshot = {
    connection: connectionSnapshot,
    session: { sessionId, kind: "structured", lifecycle: diagnostics },
  };
  const incident = deriveSessionIncident(conversationDiagnostics);
  const rateLimitResume = useRespawnSession(
    sessionId,
    state.rateLimit ? (state.rateLimit.resets_at ?? "unknown") : null,
  );

  return (
    <>
      <RateLimitRecoverySection sessionId={sessionId} currentAgent={currentAgent} onPrefill={onRecoveryPrefill}>
        {({ onSwitchAgent }) => (
          <ConversationLifecycleNotice
            sessionId={sessionId}
            incident={incident}
            onRestore={onRestore}
            onUnarchive={onUnarchive}
            onUnsnooze={onUnsnooze}
            rateLimit={state.rateLimit}
            rateLimitAutoResume={rateLimitAutoResume}
            rateLimitRetriesExhausted={state.rateLimitRetriesExhausted}
            onSwitchAgent={onSwitchAgent}
            onResumeRateLimit={() => void rateLimitResume.respawn()}
            rateLimitResumeState={rateLimitResume.state}
            rateLimitResumeError={rateLimitResume.error}
          />
        )}
      </RateLimitRecoverySection>
      {state.lastError && (
        <ActionFeedbackNotice
          title="Action did not complete"
          detail={state.lastError}
          onDismiss={dismissError}
          dismissLabel="Dismiss action error"
          testId="acp-interaction-error"
        />
      )}
    </>
  );
}

export function ConversationLifecycleNotice({
  sessionId,
  incident,
  onRestore,
  onUnarchive,
  onUnsnooze,
  rateLimit = null,
  rateLimitAutoResume,
  rateLimitRetriesExhausted = false,
  onSwitchAgent,
  onResumeRateLimit,
  rateLimitResumeState = "idle",
  rateLimitResumeError = null,
}: {
  sessionId: string;
  incident: SessionIncident | null;
  onRestore?: () => Promise<boolean> | void;
  onUnarchive?: () => Promise<boolean> | void;
  onUnsnooze?: () => Promise<boolean> | void;
  rateLimit?: AcpState["rateLimit"];
  rateLimitAutoResume?: boolean;
  rateLimitRetriesExhausted?: boolean;
  onSwitchAgent?: () => void;
  onResumeRateLimit?: () => void;
  rateLimitResumeState?: RespawnState;
  rateLimitResumeError?: string | null;
}) {
  const recoverableIncident =
    incident?.kind === "stopped" || incident?.kind === "unavailable" ? `${incident.kind}:${incident.detail}` : null;
  const {
    state: startState,
    error: startError,
    respawn: startAgent,
  } = useRespawnSession(sessionId, recoverableIncident);
  if (!incident) return null;
  if (incident.kind === "failed") return <StartupErrorBanner sessionId={sessionId} message={incident.detail} />;
  if (incident.kind === "restarting" || incident.kind === "transitioning") {
    return <WorkerRestartingBanner title={incident.title} message={incident.detail} />;
  }
  if (incident.kind === "trashed") return <TrashedWorkerStoppedBanner sessionId={sessionId} onRestore={onRestore} />;
  if (incident.kind === "archived") {
    return <ArchivedWorkerStoppedBanner sessionId={sessionId} onUnarchive={onUnarchive} />;
  }
  if (incident.kind === "snoozed") {
    return (
      <SnoozedWorkerStoppedBanner sessionId={sessionId} snoozedUntil={incident.snoozedUntil} onUnsnooze={onUnsnooze} />
    );
  }
  if (incident.kind === "stopped" || incident.kind === "unavailable") {
    return (
      <AgentStartNotice incident={incident} state={startState} error={startError} onStart={() => void startAgent()} />
    );
  }
  if (incident.kind === "blocked" && incident.reason === "rate_limited") {
    return (
      <RateLimitLifecycleBanner
        incident={incident}
        rateLimit={rateLimit}
        autoResume={rateLimitAutoResume}
        retriesExhausted={rateLimitRetriesExhausted}
        onSwitchAgent={onSwitchAgent}
        onResume={onResumeRateLimit}
        resumeState={rateLimitResumeState}
        resumeError={rateLimitResumeError}
      />
    );
  }
  return null;
}

function respawnAction(state: RespawnState, error: string | null, onStart: () => void): LifecycleNoticeAction {
  return {
    label: "Start agent",
    pendingLabel: "Starting…",
    acceptedLabel: "Start requested",
    phase: state === "retrying" ? "pending" : state === "ok" ? "accepted" : state,
    error: state === "failed" ? `Start failed: ${error ?? "unknown error"}` : null,
    onInvoke: onStart,
  };
}

function AgentStartNotice({
  incident,
  state,
  error,
  onStart,
}: {
  incident: Extract<SessionIncident, { kind: "stopped" | "unavailable" }>;
  state: RespawnState;
  error: string | null;
  onStart: () => void;
}) {
  return (
    <LifecycleIncidentNotice
      title={incident.title}
      detail={incident.detail}
      tone={incident.kind === "unavailable" ? "error" : "warning"}
      primaryAction={respawnAction(state, error, onStart)}
      testId={`acp-agent-${incident.kind}`}
    />
  );
}

function RateLimitLifecycleBanner({
  incident,
  rateLimit,
  autoResume,
  retriesExhausted,
  onSwitchAgent,
  onResume,
  resumeState,
  resumeError,
}: {
  incident: Extract<SessionIncident, { kind: "blocked" }>;
  rateLimit: AcpState["rateLimit"];
  autoResume?: boolean;
  retriesExhausted: boolean;
  onSwitchAgent?: () => void;
  onResume?: () => void;
  resumeState: RespawnState;
  resumeError: string | null;
}) {
  const resumePending = resumeState === "retrying" || resumeState === "ok";
  const resumeAction: LifecycleNoticeAction | undefined = onResume
    ? {
        label: "Resume now",
        pendingLabel: "Resuming…",
        acceptedLabel: "Resume requested",
        phase: resumeState === "retrying" ? "pending" : resumeState === "ok" ? "accepted" : resumeState,
        error: resumeState === "failed" ? `Resume failed: ${resumeError ?? "unknown error"}` : null,
        onInvoke: onResume,
      }
    : undefined;
  return (
    <LifecycleIncidentNotice
      title={incident.title}
      detail={rateLimit ? rateLimitDetail(rateLimit) : incident.detail}
      tone="warning"
      primaryAction={resumeAction}
      secondaryAction={
        onSwitchAgent
          ? { label: "Continue in another agent", pendingLabel: "Switching…", onInvoke: onSwitchAgent }
          : undefined
      }
    >
      {autoResume === true && !retriesExhausted && (
        <div className="mt-2 text-xs text-text-muted">
          Auto-resume is armed; the session resumes when the window clears.
        </div>
      )}
      {autoResume === false && (
        <div className="mt-2 text-xs text-text-muted">
          Auto-resume is off for this profile; use Resume now, or enable acp.rate_limit_auto_resume.
        </div>
      )}
      {retriesExhausted && (
        <div className="mt-2 text-xs text-status-warning">
          Auto-resume stopped after repeated attempts. Resume manually or send a new prompt.
        </div>
      )}
      {resumePending && resumeState === "ok" && (
        <div className="mt-2 text-xs text-text-muted">Resume requested. New events should start streaming shortly.</div>
      )}
    </LifecycleIncidentNotice>
  );
}

export function MonitoringBanner({ description }: { description: string | null }) {
  return (
    <ConversationNextStepNotice icon={<Eye className="size-3.5" />}>
      Monitoring a background job
      {description ? <span className="text-text-muted">: {description}</span> : null}
    </ConversationNextStepNotice>
  );
}

export function WorkerRestartingBanner({ title = "Restarting agent", message }: { title?: string; message: string }) {
  return <LifecycleIncidentNotice title={title} detail={message} tone="info" working />;
}

// A real wake flips `turnActive` within seconds, so this only clears a stale
// banner left by a fallback wakeup that its primary signal superseded.
const WAKING_GRACE_MS = 10_000;

export function ScheduledWakeupBanner({ wakeAt, reason }: { wakeAt: string; reason: string | null }) {
  const targetMs = Date.parse(wakeAt);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(false);
  const elapsed = !Number.isFinite(targetMs) || targetMs <= now;
  // A fresh wake reuses this instance; un-dismiss during render.
  const [prevWakeAt, setPrevWakeAt] = useState(wakeAt);
  if (wakeAt !== prevWakeAt) {
    setPrevWakeAt(wakeAt);
    setDismissed(false);
  }
  useEffect(() => {
    if (elapsed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [elapsed]);
  useEffect(() => {
    if (!elapsed) return;
    const id = setTimeout(() => setDismissed(true), WAKING_GRACE_MS);
    return () => clearTimeout(id);
  }, [elapsed]);
  if (!Number.isFinite(targetMs) || dismissed) return null;
  const remaining = Math.max(0, Math.floor((targetMs - now) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const wakeDate = new Date(targetMs);
  const clock = `${pad(wakeDate.getHours())}:${pad(wakeDate.getMinutes())}`;
  const inText =
    remaining < 60
      ? `${remaining}s`
      : remaining < 3600
        ? `${Math.floor(remaining / 60)}m ${pad(remaining % 60)}s`
        : `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`;
  return (
    <ConversationNextStepNotice icon={<Clock className="size-3.5" />}>
      {elapsed ? "Waking…" : `Asleep until ${clock} (in ${inText})`}
      {reason ? <span className="text-text-muted">: {reason}</span> : null}
    </ConversationNextStepNotice>
  );
}

export function TrashedWorkerStoppedBanner({
  sessionId,
  onRestore,
}: {
  sessionId: string;
  onRestore?: () => Promise<boolean> | void;
}) {
  // On success the banner unmounts, so pending only resets on failure.
  const [restoring, setRestoring] = useState(false);
  const handleRestore = () => {
    if (!onRestore || restoring) return;
    setRestoring(true);
    void Promise.resolve(onRestore()).then(
      (ok) => {
        if (ok === false) setRestoring(false);
      },
      () => setRestoring(false),
    );
  };
  return (
    <LifecycleIncidentNotice
      title="Session in trash"
      detail="This session is in the trash. Its transcript and workspace are kept and shown here read-only, but the worker is stopped and will not respawn. Restore it to resume, or delete it permanently from the Trash section in the sidebar."
      tone="warning"
      testId={`acp-trashed-banner-${sessionId}`}
      primaryAction={
        onRestore
          ? {
              label: "Restore",
              pendingLabel: "Restoring…",
              phase: restoring ? "pending" : "idle",
              onInvoke: handleRestore,
            }
          : undefined
      }
    />
  );
}

export function ArchivedWorkerStoppedBanner({
  sessionId,
  onUnarchive,
}: {
  sessionId: string;
  onUnarchive?: () => Promise<boolean> | void;
}) {
  const action = useSessionRecoveryAction("Unarchive", "Unarchiving…", "Could not unarchive session.", onUnarchive);
  return (
    <LifecycleIncidentNotice
      title="Session archived"
      detail="This session is parked. Its agent will remain stopped until you Unarchive it."
      tone="warning"
      testId={`acp-archived-banner-${sessionId}`}
      primaryAction={action}
    />
  );
}

export function SnoozedWorkerStoppedBanner({
  sessionId,
  snoozedUntil,
  onUnsnooze,
}: {
  sessionId: string;
  snoozedUntil: string;
  onUnsnooze?: () => Promise<boolean> | void;
}) {
  const target = new Date(snoozedUntil);
  const wallClock = Number.isFinite(target.getTime()) ? target.toLocaleString() : snoozedUntil;
  const action = useSessionRecoveryAction("Unsnooze", "Waking…", "Could not wake session.", onUnsnooze);
  return (
    <LifecycleIncidentNotice
      title="Session snoozed"
      detail={
        <>
          The structured view worker was shut down until <span className="font-mono">{wallClock}</span>. The reconciler
          will respawn it automatically once the snooze expires. You can also Unsnooze it now.
        </>
      }
      tone="warning"
      testId={`acp-snoozed-banner-${sessionId}`}
      primaryAction={action}
    />
  );
}

function useSessionRecoveryAction(
  label: string,
  pendingLabel: string,
  failureLabel: string,
  invoke?: () => Promise<boolean> | void,
): LifecycleNoticeAction | undefined {
  const [phase, setPhase] = useState<"idle" | "pending" | "failed">("idle");
  if (!invoke) return undefined;
  return {
    label,
    pendingLabel,
    phase,
    error: phase === "failed" ? failureLabel : null,
    onInvoke: () => {
      if (phase === "pending") return;
      setPhase("pending");
      void Promise.resolve(invoke()).then(
        (ok) => {
          if (ok === false) setPhase("failed");
        },
        () => setPhase("failed"),
      );
    },
  };
}
