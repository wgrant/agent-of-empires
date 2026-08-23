import {
  selectConnectionDiagnostics,
  type ConnectionDiagnostics,
  type ConnectionStatusSnapshot,
} from "./connectionStatus";
import type { AgentState, SessionDiagnostics } from "./sessionDiagnostics";

export interface SelectedSessionDiagnostics {
  sessionId: string;
  kind: "structured" | "terminal";
  lifecycle: SessionDiagnostics;
}

/**
 * The dashboard-level transport model and optional selected-session model are
 * peers. Connection health remains its own diagnostic layer; lifecycle uses
 * it only to decide whether a message can reach the selected session now.
 */
export interface ConversationDiagnosticsSnapshot {
  connection: ConnectionStatusSnapshot;
  session: SelectedSessionDiagnostics | null;
}

export type SessionAction =
  | "restore"
  | "unarchive"
  | "unsnooze"
  | "start_agent"
  | "retry_start"
  | "switch_agent"
  | "wait";

interface SessionIncidentBase {
  action: SessionAction;
  title: string;
  detail: string;
}

export type SessionIncident =
  | (SessionIncidentBase & { kind: "trashed"; action: "restore" })
  | (SessionIncidentBase & { kind: "archived"; action: "unarchive" })
  | (SessionIncidentBase & { kind: "snoozed"; action: "unsnooze"; snoozedUntil: string })
  | (SessionIncidentBase & {
      kind: "failed";
      action: "retry_start";
      category: "startup" | "compatibility";
    })
  | (SessionIncidentBase & { kind: "stopped"; action: "start_agent" })
  | (SessionIncidentBase & { kind: "unavailable"; action: "start_agent" })
  | (SessionIncidentBase & { kind: "blocked"; action: "switch_agent"; reason: "rate_limited" })
  | (SessionIncidentBase & {
      kind: "transitioning";
      action: "wait";
      operation: "start" | "wake" | "stop";
    })
  | (SessionIncidentBase & {
      kind: "restarting";
      action: "wait";
      reason: "manual_restart" | "cancel_unresponsive" | "prompt_orphaned";
    });

function restartDetail(reason: NonNullable<Extract<AgentState, { kind: "transitioning" }>["reason"]>): string {
  switch (reason) {
    case "prompt_orphaned":
      return "Agent finished but didn't notify the daemon. Restarting worker; your transcript will be preserved.";
    case "cancel_unresponsive":
      return "Agent stopped responding to cancel. Restarting worker; your transcript will be preserved.";
    case "manual_restart":
      return "Restarting structured view worker… the daemon will respawn the agent with your existing transcript shortly.";
  }
}

function transitionPresentation(operation: "start" | "wake" | "stop") {
  switch (operation) {
    case "start":
      return { title: "Starting agent", detail: "The agent is starting. Messages will be delivered when it is ready." };
    case "wake":
      return {
        title: "Waking agent",
        detail: "The idle agent is waking. Messages will be delivered when it is ready.",
      };
    case "stop":
      return {
        title: "Stopping agent",
        detail: "The agent is stopping. New messages will wait until it is started again.",
      };
  }
}

export type ComposerAvailability =
  | { kind: "read_only"; reason: "trashed"; action: "restore" }
  | { kind: "resume_then_send"; reason: "archived" | "snoozed" | "stopped" }
  | { kind: "blocked"; reason: "failed" | "rate_limited"; action?: "retry_start" | "switch_agent" }
  | { kind: "send_now" }
  | { kind: "steer_now" }
  | { kind: "queue_after_turn" }
  | { kind: "queue_for_recovery" }
  | { kind: "wake_agent" };

export function selectConversationConnection(snapshot: ConversationDiagnosticsSnapshot): ConnectionDiagnostics {
  return selectConnectionDiagnostics(snapshot.connection);
}

/**
 * Selects one actionable lifecycle incident. A route incident is deliberately
 * not represented here: connection UI owns it, and session observations are
 * historical while the dashboard is unavailable.
 */
export function deriveSessionIncident(snapshot: ConversationDiagnosticsSnapshot): SessionIncident | null {
  const session = snapshot.session;
  if (!session) return null;
  const connection = selectConversationConnection(snapshot);
  if (connection.route !== "connected") return null;

  const { operational } = session.lifecycle;
  if (operational.kind === "trashed") {
    return {
      kind: "trashed",
      action: "restore",
      title: "Session in trash",
      detail: "Restore this session before it can run an agent again.",
    };
  }
  if (operational.kind === "archived") {
    return {
      kind: "archived",
      action: "unarchive",
      title: "Session archived",
      detail: "Unarchive this session before it can run an agent again.",
    };
  }
  if (operational.kind === "snoozed") {
    return {
      kind: "snoozed",
      action: "unsnooze",
      title: "Session snoozed",
      detail: "This session will resume when its snooze expires, or you can wake it sooner.",
      snoozedUntil: operational.until,
    };
  }
  if (operational.kind !== "active") return null;
  const { agent } = operational;
  switch (agent.kind) {
    case "failed":
      return {
        kind: "failed",
        action: "retry_start",
        title: "Agent could not start",
        detail: agent.message,
        category: agent.category === "compatibility" ? "compatibility" : "startup",
      };
    case "stopped":
      return {
        kind: "stopped",
        action: "start_agent",
        title: "Agent stopped",
        detail: "Start the agent when you are ready to continue.",
      };
    case "transitioning":
      if (agent.operation === "restart" || agent.operation === "recover") {
        const reason = agent.reason ?? "manual_restart";
        return {
          kind: "restarting",
          action: "wait",
          title: agent.operation === "recover" ? "Recovering agent" : "Restarting agent",
          detail: restartDetail(reason),
          reason,
        };
      }
      if (agent.operation === "start" || agent.operation === "wake" || agent.operation === "stop") {
        return {
          kind: "transitioning",
          action: "wait",
          operation: agent.operation,
          ...transitionPresentation(agent.operation),
        };
      }
      return null;
    case "online":
      if (agent.condition.kind !== "rate_limited") return null;
      return {
        kind: "blocked",
        action: "switch_agent",
        title: "Agent is rate limited",
        detail: "The provider is not accepting work for this session.",
        reason: "rate_limited",
      };
    case "dormant":
      return null;
    case "unknown":
      return {
        kind: "unavailable",
        action: "start_agent",
        title: "Agent unavailable",
        detail: agent.detail ?? "No agent worker is running and no start is in progress.",
      };
    default:
      return null;
  }
}

/**
 * Central policy for what submitting a prompt means. It intentionally exposes
 * the current archive/snooze auto-resume behavior as `resume_then_send`, so a
 * later product decision can change that one policy without reintroducing
 * separate component and dispatch gates.
 */
export function deriveComposerAvailability(snapshot: ConversationDiagnosticsSnapshot): ComposerAvailability {
  const session = snapshot.session;
  if (!session) return { kind: "blocked", reason: "failed" };
  const connection = selectConversationConnection(snapshot);
  const { operational } = session.lifecycle;

  if (operational.kind === "trashed") return { kind: "read_only", reason: "trashed", action: "restore" };
  if (operational.kind === "archived") return { kind: "resume_then_send", reason: "archived" };
  if (operational.kind === "snoozed") return { kind: "resume_then_send", reason: "snoozed" };
  if (operational.kind === "creating" || operational.kind === "deleting") {
    return { kind: "blocked", reason: "failed" };
  }

  const { agent } = operational;
  if (agent.kind === "failed") return { kind: "blocked", reason: "failed", action: "retry_start" };
  if (agent.kind === "stopped") return { kind: "resume_then_send", reason: "stopped" };
  if (agent.kind === "dormant") return { kind: "wake_agent" };
  if (agent.kind === "unknown" || agent.kind === "transitioning") return { kind: "queue_for_recovery" };
  if (agent.condition.kind === "rate_limited") {
    return { kind: "blocked", reason: "rate_limited", action: "switch_agent" };
  }
  if (connection.route !== "connected") return { kind: "queue_for_recovery" };
  if (agent.turn.kind === "cancelling" || agent.turn.kind === "compacting") return { kind: "queue_after_turn" };
  if (agent.turn.kind === "running" || agent.turn.kind === "awaiting_user") {
    return agent.canSteer ? { kind: "steer_now" } : { kind: "queue_after_turn" };
  }
  return { kind: "send_now" };
}
