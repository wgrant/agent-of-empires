import type { AcpState } from "../../../lib/acpTypes";

export type AcpWorkerLifecycleState = "absent" | "resuming" | "running" | "stopping";

export type SessionDisposition =
  | { kind: "live" }
  | { kind: "archived"; archivedAt: string }
  | { kind: "snoozed"; until: string }
  | { kind: "trashed"; trashedAt: string };

export type AgentRuntime =
  | { kind: "unknown" }
  | { kind: "starting" }
  | { kind: "stopping" }
  | { kind: "ready" }
  | { kind: "dormant"; reason: "idle_auto_stop" }
  | {
      kind: "restarting";
      reason: "manual_restart" | "cancel_unresponsive" | "prompt_orphaned";
    }
  | { kind: "stopped"; reason: "user_stopped" }
  | { kind: "blocked"; reason: "rate_limited" }
  | { kind: "failed"; category: "startup" | "compatibility"; message: string };

export type TurnExecution =
  | { kind: "idle" }
  | { kind: "running"; activity: "thinking" | "tool" | "streaming" | "waiting"; tool: string | null }
  | { kind: "awaiting_user"; request: "approval" | "elicitation" }
  | { kind: "cancelling"; escalatesAt: string | null }
  | { kind: "compacting" }
  | { kind: "scheduled"; wakeAt: string; reason: string | null }
  | { kind: "monitoring"; description: string | null };

export interface SessionDiagnosticEvidence {
  workerState: AcpWorkerLifecycleState;
  startupError: string | null;
  incompatibleAgent: AcpState["incompatibleAgent"];
  rateLimit: AcpState["rateLimit"];
  workerStopped: boolean;
  workerRestarting: boolean;
  workerIdleStopped: boolean;
  agentUnresponsive: boolean;
  agentOrphaned: boolean;
  canSteer: boolean;
}

export interface SessionDiagnostics {
  disposition: SessionDisposition;
  runtime: AgentRuntime;
  turn: TurnExecution;
  evidence: SessionDiagnosticEvidence;
}

export interface SessionDiagnosticsInput {
  state: AcpState;
  workerState: AcpWorkerLifecycleState;
  archivedAt: string | null;
  snoozedUntil: string | null;
  trashedAt: string | null;
}

function deriveDisposition(input: SessionDiagnosticsInput): SessionDisposition {
  if (input.trashedAt) return { kind: "trashed", trashedAt: input.trashedAt };
  if (input.archivedAt) return { kind: "archived", archivedAt: input.archivedAt };
  if (input.snoozedUntil) return { kind: "snoozed", until: input.snoozedUntil };
  return { kind: "live" };
}

function deriveRuntime(input: SessionDiagnosticsInput): AgentRuntime {
  const { state, workerState } = input;
  if (state.incompatibleAgent) {
    return { kind: "failed", category: "compatibility", message: "The configured agent is incompatible." };
  }
  if (state.startupError) return { kind: "failed", category: "startup", message: state.startupError };
  if (state.rateLimit) return { kind: "blocked", reason: "rate_limited" };
  if (workerState === "stopping") return { kind: "stopping" };
  if (state.workerStopped) return { kind: "stopped", reason: "user_stopped" };
  if (state.agentOrphaned) return { kind: "restarting", reason: "prompt_orphaned" };
  if (state.agentUnresponsive) return { kind: "restarting", reason: "cancel_unresponsive" };
  if (state.workerRestarting || workerState === "resuming") return { kind: "restarting", reason: "manual_restart" };
  if (state.workerIdleStopped) return { kind: "dormant", reason: "idle_auto_stop" };
  if (workerState === "running") return { kind: "ready" };
  return { kind: "starting" };
}

function deriveTurn(state: AcpState): TurnExecution {
  if (state.pendingApprovals.length > 0) return { kind: "awaiting_user", request: "approval" };
  if (state.pendingElicitations.length > 0) return { kind: "awaiting_user", request: "elicitation" };
  if (state.cancelling) return { kind: "cancelling", escalatesAt: state.cancelEscalatesAt };
  if (state.compacting) return { kind: "compacting" };
  if (state.turnActive) {
    if (state.inFlightTool) return { kind: "running", activity: "tool", tool: state.inFlightTool.name };
    if (state.thinking) return { kind: "running", activity: "thinking", tool: null };
    if (state.activity.at(-1)?.kind === "message") {
      return { kind: "running", activity: "streaming", tool: null };
    }
    return { kind: "running", activity: "waiting", tool: null };
  }
  if (state.nextWakeupAt) return { kind: "scheduled", wakeAt: state.nextWakeupAt, reason: state.nextWakeupReason };
  if (state.monitorArmed) return { kind: "monitoring", description: state.monitorDescription };
  return { kind: "idle" };
}

/**
 * Normalizes existing ACP observations into independent lifecycle facts.
 * This is intentionally a read-only adapter: reducer flags and worker polling
 * remain the source observations until all consumers have migrated.
 */
export function deriveSessionDiagnostics(input: SessionDiagnosticsInput): SessionDiagnostics {
  const { state, workerState } = input;
  return {
    disposition: deriveDisposition(input),
    runtime: deriveRuntime(input),
    turn: deriveTurn(state),
    evidence: {
      workerState,
      startupError: state.startupError,
      incompatibleAgent: state.incompatibleAgent,
      rateLimit: state.rateLimit,
      workerStopped: state.workerStopped,
      workerRestarting: state.workerRestarting,
      workerIdleStopped: state.workerIdleStopped,
      agentUnresponsive: state.agentUnresponsive,
      agentOrphaned: state.agentOrphaned,
      canSteer: state.promptCapabilities?.steering ?? false,
    },
  };
}
