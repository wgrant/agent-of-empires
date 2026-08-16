import {
  selectConnectionDiagnostics,
  type ConnectionDiagnostics,
  type ConnectionStatusSnapshot,
} from "./connectionStatus";
import type { SessionDiagnostics } from "./sessionDiagnostics";

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
  | "reconnect"
  | "retry_start"
  | "switch_agent"
  | "wait";

export interface SessionIncident {
  kind: "trashed" | "archived" | "snoozed" | "failed" | "stopped" | "blocked" | "restarting" | "dormant";
  action: SessionAction;
  title: string;
  detail: string;
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

  const { disposition, runtime } = session.lifecycle;
  if (disposition.kind === "trashed") {
    return {
      kind: "trashed",
      action: "restore",
      title: "Session in trash",
      detail: "Restore this session before it can run an agent again.",
    };
  }
  if (disposition.kind === "archived") {
    return {
      kind: "archived",
      action: "unarchive",
      title: "Session archived",
      detail: "Unarchive this session before it can run an agent again.",
    };
  }
  if (disposition.kind === "snoozed") {
    return {
      kind: "snoozed",
      action: "unsnooze",
      title: "Session snoozed",
      detail: "This session will resume when its snooze expires, or you can wake it sooner.",
    };
  }
  switch (runtime.kind) {
    case "failed":
      return {
        kind: "failed",
        action: "retry_start",
        title: "Agent could not start",
        detail: runtime.message,
      };
    case "stopped":
      return {
        kind: "stopped",
        action: "reconnect",
        title: "Agent stopped",
        detail: "Reconnect to start the agent again.",
      };
    case "blocked":
      return {
        kind: "blocked",
        action: "switch_agent",
        title: "Agent is rate limited",
        detail: "The provider is not accepting work for this session.",
      };
    case "restarting":
      return {
        kind: "restarting",
        action: "wait",
        title: "Restarting agent",
        detail: "AoE is restoring the agent session.",
      };
    case "dormant":
      return {
        kind: "dormant",
        action: "wait",
        title: "Agent paused while idle",
        detail: "The next message wakes this session automatically.",
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
  const { disposition, runtime, turn } = session.lifecycle;

  if (disposition.kind === "trashed") return { kind: "read_only", reason: "trashed", action: "restore" };
  if (runtime.kind === "failed") return { kind: "blocked", reason: "failed", action: "retry_start" };
  if (runtime.kind === "blocked") return { kind: "blocked", reason: "rate_limited", action: "switch_agent" };
  if (disposition.kind === "archived") return { kind: "resume_then_send", reason: "archived" };
  if (disposition.kind === "snoozed") return { kind: "resume_then_send", reason: "snoozed" };
  if (runtime.kind === "stopped") return { kind: "resume_then_send", reason: "stopped" };
  if (connection.route !== "connected" || runtime.kind === "starting" || runtime.kind === "restarting") {
    return { kind: "queue_for_recovery" };
  }
  if (runtime.kind === "dormant") return { kind: "wake_agent" };
  if (turn.kind === "awaiting_user" || turn.kind === "cancelling" || turn.kind === "compacting") {
    return { kind: "queue_after_turn" };
  }
  if (turn.kind === "running") {
    return session.lifecycle.evidence.workerState === "running" && session.lifecycle.evidence.workerStopped === false
      ? { kind: "steer_now" }
      : { kind: "queue_after_turn" };
  }
  return { kind: "send_now" };
}
