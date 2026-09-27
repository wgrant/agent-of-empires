import type { ComposerAvailability } from "./conversationDiagnostics";

/** A single conversation synchronization operation. Presentation decides
 * whether this is a full session transition or an in-place update. */
export type ConversationSyncStatus = "idle" | "initial" | "reconnect" | "history";

export function deriveConversationSyncStatus({
  replaySyncing,
  hasEverOpened,
  loadingEarlier,
  connectionStarting,
}: {
  replaySyncing: boolean;
  hasEverOpened: boolean;
  loadingEarlier: boolean;
  connectionStarting: boolean;
}): ConversationSyncStatus {
  if (replaySyncing || (!hasEverOpened && connectionStarting)) return hasEverOpened ? "reconnect" : "initial";
  if (loadingEarlier) return "history";
  return "idle";
}

export function composerAvailabilityNoticeLabel(
  availability: ComposerAvailability,
  conversationSync: ConversationSyncStatus,
): string | null {
  if (conversationSync === "reconnect") {
    return "Updating conversation…";
  }
  if (availability.kind === "queue_for_recovery") {
    return "Messages will be queued until the session resumes.";
  }
  return null;
}
