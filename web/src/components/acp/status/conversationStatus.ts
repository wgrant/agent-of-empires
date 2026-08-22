import type { ConversationSyncStatus } from "./conversationSyncStatus";
import type { AgentRuntime, SessionDiagnostics } from "./sessionDiagnostics";

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

/** Only a ready normalized runtime may publish turn state at the transcript
 * tail. Every recovery, blocked, stopped, dormant, failed, starting, or
 * unknown runtime can carry stale turn observations from before transition. */
export function runtimeAllowsConversationTail(runtime: AgentRuntime): boolean {
  switch (runtime.kind) {
    case "ready":
      return true;
    case "unknown":
    case "starting":
    case "dormant":
    case "restarting":
    case "stopped":
    case "blocked":
    case "failed":
      return false;
  }
}

export function deriveConversationNextStep({
  sync,
  diagnostics,
}: {
  sync: ConversationSyncStatus;
  diagnostics: SessionDiagnostics;
}): ConversationNextStep {
  if (sync === "initial" || sync === "history") return { kind: "catching_up" };
  if (sync === "reconnect" || !runtimeAllowsConversationTail(diagnostics.runtime)) return null;

  switch (diagnostics.turn.kind) {
    case "awaiting_user":
    case "idle":
      return null;
    case "cancelling":
      return {
        kind: "working",
        thinking: false,
        tool: null,
        cancelling: true,
        cancelEscalatesAt: diagnostics.turn.escalatesAt,
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
        thinking: diagnostics.turn.activity === "thinking",
        tool: diagnostics.turn.tool,
        cancelling: false,
        cancelEscalatesAt: null,
        compacting: false,
      };
    case "scheduled":
      return { kind: "scheduled_wakeup", wakeAt: diagnostics.turn.wakeAt, reason: diagnostics.turn.reason };
    case "monitoring":
      return { kind: "monitoring", description: diagnostics.turn.description };
  }
}
