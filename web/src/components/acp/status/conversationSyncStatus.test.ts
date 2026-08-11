import { describe, expect, it } from "vitest";

import { deriveConversationSyncStatus } from "./conversationSyncStatus";

describe("deriveConversationSyncStatus", () => {
  it("classifies replay and history work by its conversation context", () => {
    const cases = [
      [{ replaySyncing: false, hasEverOpened: false, loadingEarlier: false, connectionStarting: false }, "idle"],
      [{ replaySyncing: false, hasEverOpened: false, loadingEarlier: false, connectionStarting: true }, "initial"],
      [{ replaySyncing: true, hasEverOpened: false, loadingEarlier: true, connectionStarting: true }, "initial"],
      [{ replaySyncing: true, hasEverOpened: true, loadingEarlier: false, connectionStarting: false }, "reconnect"],
      [{ replaySyncing: false, hasEverOpened: true, loadingEarlier: true, connectionStarting: false }, "history"],
    ] as const;
    for (const [input, expected] of cases) expect(deriveConversationSyncStatus(input)).toBe(expected);
  });
});
