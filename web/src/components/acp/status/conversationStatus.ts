import type { AgentSessionStatus } from "./connectionStatus";
import type { ConversationSyncStatus } from "./conversationSyncStatus";

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

/** Compatibility projection for callers that only render the transcript-tail
 * activity state. New status consumers should use deriveConversationStatus. */
export type ConversationNextStep =
  | { kind: "catching_up" }
  | { kind: "working" }
  | { kind: "scheduled_wakeup" }
  | { kind: "monitoring" }
  | null;

export function deriveConversationNextStep({
  initialCatchup,
  turnActive,
  nextWakeupAt,
  monitorArmed,
}: {
  initialCatchup: boolean;
  turnActive: boolean;
  nextWakeupAt: string | null;
  monitorArmed: boolean;
}): ConversationNextStep {
  const status = deriveConversationStatus({
    agentSession: "ready",
    sync: initialCatchup ? "initial" : "idle",
    turnActive,
    nextWakeupAt,
    monitorArmed,
  });
  if (status.kind === "updating" && status.cause === "initial") return { kind: "catching_up" };
  if (status.kind === "active") return { kind: "working" };
  if (status.kind === "waiting") return { kind: status.cause };
  return null;
}
