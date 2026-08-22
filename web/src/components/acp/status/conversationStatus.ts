import type { ConversationSyncStatus } from "./conversationSyncStatus";
import type { SessionDiagnostics } from "./sessionDiagnostics";

/** View model for the transcript's single next-step slot. */
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
  diagnostics,
}: {
  sync: ConversationSyncStatus;
  diagnostics: SessionDiagnostics;
}): ConversationNextStep {
  if (sync === "initial" || sync === "history") return { kind: "catching_up" };
  if (sync === "reconnect") return null;

  const operational = diagnostics.operational;
  if (operational.kind !== "active" || operational.agent.kind !== "online") return null;
  const { turn } = operational.agent;

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
