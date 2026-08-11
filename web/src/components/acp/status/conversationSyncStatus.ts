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
