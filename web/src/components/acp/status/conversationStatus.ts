import type { AgentSessionStatus } from "./connectionStatus";
import type { ConversationSyncStatus } from "./conversationSyncStatus";
import type { TurnExecution } from "./sessionDiagnostics";

export type ConversationStatusTone = "neutral" | "progress" | "warning" | "error";
export type ConversationStatusPlacement = "session" | "transcript_tail" | "composer";
export type ComposerAvailability = "available" | "queue" | "disabled";

/** The single highest-priority state of a conversation, excluding ephemeral
 * local feedback such as a failed button click or a dismissed suggestion. */
export type ConversationStatus =
  | {
      kind: "blocked";
      cause: "agent_failed" | "agent_stopped" | "rate_limited";
      tone: "warning" | "error";
      placement: "session";
      composer: "disabled" | "queue";
    }
  | {
      kind: "updating";
      cause: "initial" | "reconnect" | "agent_starting" | "agent_restarting";
      tone: "progress";
      placement: "session" | "composer";
      composer: "queue";
    }
  | {
      kind: "active";
      cause: "working";
      tone: "neutral";
      placement: "transcript_tail";
      composer: "queue";
    }
  | {
      kind: "waiting";
      cause: "scheduled_wakeup" | "monitoring";
      tone: "neutral";
      placement: "transcript_tail";
      composer: "available";
    }
  | {
      kind: "idle";
      tone: "neutral";
      placement: null;
      composer: "available";
    };

export interface ConversationStatusInput {
  agentSession: AgentSessionStatus;
  sync: ConversationSyncStatus;
  turnActive: boolean;
  nextWakeupAt: string | null;
  monitorArmed: boolean;
}

/**
 * Derives one conversation status from lifecycle, synchronization, and agent
 * activity. Connection diagnostics own the raw lifecycle observation; this
 * function assigns its conversation-level priority and presentation home.
 */
export function deriveConversationStatus(input: ConversationStatusInput): ConversationStatus {
  switch (input.agentSession) {
    case "failed":
      return { kind: "blocked", cause: "agent_failed", tone: "error", placement: "session", composer: "disabled" };
    case "stopped":
      return { kind: "blocked", cause: "agent_stopped", tone: "error", placement: "session", composer: "disabled" };
    case "rate_limited":
      return { kind: "blocked", cause: "rate_limited", tone: "warning", placement: "session", composer: "queue" };
    case "starting":
      return { kind: "updating", cause: "agent_starting", tone: "progress", placement: "session", composer: "queue" };
    case "restarting":
    case "unresponsive":
      return { kind: "updating", cause: "agent_restarting", tone: "progress", placement: "session", composer: "queue" };
    case "ready":
    case "unknown":
      break;
  }

  if (input.sync === "initial") {
    return { kind: "updating", cause: "initial", tone: "progress", placement: "session", composer: "queue" };
  }
  if (input.sync === "reconnect") {
    return { kind: "updating", cause: "reconnect", tone: "progress", placement: "composer", composer: "queue" };
  }
  if (input.turnActive) {
    return { kind: "active", cause: "working", tone: "neutral", placement: "transcript_tail", composer: "queue" };
  }
  if (input.nextWakeupAt) {
    return {
      kind: "waiting",
      cause: "scheduled_wakeup",
      tone: "neutral",
      placement: "transcript_tail",
      composer: "available",
    };
  }
  if (input.monitorArmed) {
    return {
      kind: "waiting",
      cause: "monitoring",
      tone: "neutral",
      placement: "transcript_tail",
      composer: "available",
    };
  }
  return { kind: "idle", tone: "neutral", placement: null, composer: "available" };
}

/** View model for the transcript's single next-step slot. Turn details come
 * from SessionDiagnostics, while ConversationStatus owns recovery precedence. */
export type ConversationNextStep =
  | { kind: "catching_up" }
  | {
      kind: "working";
      thinking: boolean;
      tool: string | null;
      cancelling: boolean;
      cancelEscalatesAt: string | null;
      compacting: boolean;
    }
  | { kind: "scheduled_wakeup"; wakeAt: string; reason: string | null }
  | { kind: "monitoring"; description: string | null }
  | null;

export function deriveConversationNextStep({
  sync,
  status,
  turn,
}: {
  sync: ConversationSyncStatus;
  status: ConversationStatus;
  turn: TurnExecution;
}): ConversationNextStep {
  if (sync === "initial" || sync === "history") return { kind: "catching_up" };
  if (status.kind === "blocked" || status.kind === "updating") return null;

  switch (turn.kind) {
    case "awaiting_user":
    case "idle":
      return null;
    case "cancelling":
      return {
        kind: "working",
        thinking: false,
        tool: null,
        cancelling: true,
        cancelEscalatesAt: turn.escalatesAt,
        compacting: false,
      };
    case "compacting":
      return {
        kind: "working",
        thinking: false,
        tool: null,
        cancelling: false,
        cancelEscalatesAt: null,
        compacting: true,
      };
    case "running":
      return {
        kind: "working",
        thinking: turn.activity === "thinking",
        tool: turn.tool,
        cancelling: false,
        cancelEscalatesAt: null,
        compacting: false,
      };
    case "scheduled":
      return { kind: "scheduled_wakeup", wakeAt: turn.wakeAt, reason: turn.reason };
    case "monitoring":
      return { kind: "monitoring", description: turn.description };
  }
}
