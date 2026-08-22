import type { AcpState } from "../../../lib/acpTypes";
import type { SessionStatus } from "../../../lib/types";

export type AcpWorkerLifecycleState = "absent" | "resuming" | "running" | "stopping";

export type AgentTransitionOperation = "start" | "wake" | "restart" | "recover" | "stop";

export type PendingAgentOperation = {
  kind: "start" | "restart" | "stop";
  stage: "requesting" | "accepted";
  startedAt: string | null;
  operationId: string | null;
  error: string | null;
};

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

export type OnlineAgentCondition =
  | { kind: "normal" }
  | { kind: "rate_limited"; resetsAt: string | null; message: string | null };

export type AgentState =
  | { kind: "unknown"; detail: string | null }
  | { kind: "stopped"; cause: "user" }
  | { kind: "dormant"; cause: "idle" }
  | {
      kind: "transitioning";
      operation: AgentTransitionOperation;
      reason: "manual_restart" | "cancel_unresponsive" | "prompt_orphaned" | null;
      startedAt: string | null;
      operationId: string | null;
    }
  | {
      kind: "failed";
      operation: Exclude<AgentTransitionOperation, "stop"> | null;
      category: "startup" | "compatibility" | "worker";
      message: string;
    }
  | {
      kind: "online";
      since: string | null;
      condition: OnlineAgentCondition;
      turn: TurnExecution;
    };

export type SessionOperationalState =
  | { kind: "creating" }
  | { kind: "deleting" }
  | { kind: "trashed"; trashedAt: string }
  | { kind: "archived"; archivedAt: string }
  | { kind: "snoozed"; until: string }
  | { kind: "active"; agent: AgentState };

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
  operational: SessionOperationalState;
  /** Transitional flat projections retained while existing consumers move to
   * the hierarchical operational model. */
  disposition: SessionDisposition;
  runtime: AgentRuntime;
  turn: TurnExecution;
  evidence: SessionDiagnosticEvidence;
}

export interface SessionDiagnosticsInput {
  state: AcpState;
  workerState: AcpWorkerLifecycleState;
  sessionStatus: SessionStatus;
  dormant: boolean;
  archivedAt: string | null;
  snoozedUntil: string | null;
  trashedAt: string | null;
  lastError?: string | null;
  pendingOperation?: PendingAgentOperation | null;
}

function deriveTransition(
  state: AcpState,
): Pick<Extract<AgentState, { kind: "transitioning" }>, "operation" | "reason"> {
  if (state.agentOrphaned) return { operation: "recover", reason: "prompt_orphaned" };
  if (state.agentUnresponsive) return { operation: "recover", reason: "cancel_unresponsive" };
  if (state.workerRestarting) return { operation: "restart", reason: "manual_restart" };
  return { operation: "start", reason: null };
}

function deriveAgent(input: SessionDiagnosticsInput): AgentState {
  const { state, workerState } = input;
  const pending = input.pendingOperation;

  if (pending?.error) {
    return {
      kind: "failed",
      operation: pending.kind === "stop" ? null : pending.kind,
      category: "worker",
      message: pending.error,
    };
  }
  if (pending?.kind === "stop") {
    if (input.sessionStatus === "Stopped" && workerState === "absent") return { kind: "stopped", cause: "user" };
    return {
      kind: "transitioning",
      operation: "stop",
      reason: null,
      startedAt: pending.startedAt,
      operationId: pending.operationId,
    };
  }
  if (pending && workerState !== "running") {
    return {
      kind: "transitioning",
      operation: pending.kind,
      reason: pending.kind === "restart" ? "manual_restart" : null,
      startedAt: pending.startedAt,
      operationId: pending.operationId,
    };
  }

  if (workerState === "stopping") {
    return { kind: "transitioning", operation: "stop", reason: null, startedAt: null, operationId: null };
  }

  if (workerState === "running") {
    return {
      kind: "online",
      since: null,
      condition: state.rateLimit
        ? { kind: "rate_limited", resetsAt: state.rateLimit.resets_at, message: null }
        : { kind: "normal" },
      turn: deriveTurn(state),
    };
  }
  if (workerState === "resuming") {
    return {
      kind: "transitioning",
      ...deriveTransition(state),
      startedAt: null,
      operationId: null,
    };
  }
  if (input.sessionStatus === "Stopped" || state.workerStopped) return { kind: "stopped", cause: "user" };
  if (state.workerIdleStopped || input.dormant) return { kind: "dormant", cause: "idle" };
  if (state.incompatibleAgent) {
    return {
      kind: "failed",
      operation: "start",
      category: "compatibility",
      message: "The configured agent is incompatible.",
    };
  }
  const failure = state.startupError ?? (input.sessionStatus === "Error" ? input.lastError : null);
  if (failure) return { kind: "failed", operation: "start", category: "startup", message: failure };
  if (input.sessionStatus === "Starting") {
    return { kind: "transitioning", operation: "start", reason: null, startedAt: null, operationId: null };
  }
  if (state.agentOrphaned || state.agentUnresponsive || state.workerRestarting) {
    return {
      kind: "transitioning",
      ...deriveTransition(state),
      startedAt: null,
      operationId: null,
    };
  }
  return { kind: "unknown", detail: "No worker is running and no start is in progress." };
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

function deriveOperationalState(input: SessionDiagnosticsInput): SessionOperationalState {
  if (input.sessionStatus === "Creating") return { kind: "creating" };
  if (input.sessionStatus === "Deleting") return { kind: "deleting" };
  if (input.trashedAt) return { kind: "trashed", trashedAt: input.trashedAt };
  if (input.archivedAt) return { kind: "archived", archivedAt: input.archivedAt };
  if (input.snoozedUntil) return { kind: "snoozed", until: input.snoozedUntil };
  return { kind: "active", agent: deriveAgent(input) };
}

function projectDisposition(operational: SessionOperationalState): SessionDisposition {
  switch (operational.kind) {
    case "trashed":
      return { kind: "trashed", trashedAt: operational.trashedAt };
    case "archived":
      return { kind: "archived", archivedAt: operational.archivedAt };
    case "snoozed":
      return { kind: "snoozed", until: operational.until };
    default:
      return { kind: "live" };
  }
}

function projectRuntime(operational: SessionOperationalState): AgentRuntime {
  if (operational.kind !== "active") return { kind: "unknown" };
  const { agent } = operational;
  switch (agent.kind) {
    case "unknown":
      return { kind: "unknown" };
    case "stopped":
      return { kind: "stopped", reason: "user_stopped" };
    case "dormant":
      return { kind: "dormant", reason: "idle_auto_stop" };
    case "transitioning":
      if (agent.reason) return { kind: "restarting", reason: agent.reason };
      if (agent.operation === "stop") return { kind: "stopping" };
      return { kind: "starting" };
    case "failed":
      return {
        kind: "failed",
        category: agent.category === "compatibility" ? "compatibility" : "startup",
        message: agent.message,
      };
    case "online":
      return agent.condition.kind === "rate_limited" ? { kind: "blocked", reason: "rate_limited" } : { kind: "ready" };
  }
}

/**
 * Normalizes existing ACP observations into independent lifecycle facts.
 * This is intentionally a read-only adapter: reducer flags and worker polling
 * remain the source observations until all consumers have migrated.
 */
export function deriveSessionDiagnostics(input: SessionDiagnosticsInput): SessionDiagnostics {
  const { state, workerState } = input;
  const operational = deriveOperationalState(input);
  return {
    operational,
    disposition: projectDisposition(operational),
    runtime: projectRuntime(operational),
    turn:
      operational.kind === "active" && operational.agent.kind === "online" ? operational.agent.turn : { kind: "idle" },
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
