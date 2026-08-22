import { describe, expect, it } from "vitest";

import type { QueuedPrompt, RejectedPrompt } from "./acpTypes";
import { derivePromptOutbox } from "./acpPromptOutbox";

describe("ACP prompt outbox", () => {
  it("classifies reducer-owned queued and rejected prompts as explicit delivery entries", () => {
    const queued: QueuedPrompt = { id: "q1", text: "wait", queuedAt: "2026-08-16T12:00:00Z" };
    const rejected: RejectedPrompt = {
      id: "r1",
      text: "retry",
      reason: "agent busy",
      rejectedAt: "2026-08-16T12:01:00Z",
    };
    const cases = [
      {
        name: "empty",
        input: { queued: [], rejected: [], waitingForRecovery: false },
        expectedEntries: [],
        expectedDelivery: null,
      },
      {
        name: "queued until the current turn completes",
        input: { queued: [queued], rejected: [], waitingForRecovery: false },
        expectedEntries: [
          {
            id: "q1",
            text: "wait",
            createdAt: "2026-08-16T12:00:00Z",
            source: "queued",
            delivery: { kind: "queued", until: "turn_complete" },
          },
        ],
        expectedDelivery: "ready_after_turn",
      },
      {
        name: "queued until agent recovery",
        input: { queued: [queued], rejected: [], waitingForRecovery: true },
        expectedEntries: [
          {
            id: "q1",
            source: "queued",
            delivery: { kind: "queued", until: "agent_ready" },
          },
        ],
        expectedDelivery: "waiting_for_recovery",
      },
      {
        name: "rejected with the reducer reason",
        input: { queued: [], rejected: [rejected], waitingForRecovery: false },
        expectedEntries: [
          {
            id: "r1",
            text: "retry",
            createdAt: "2026-08-16T12:01:00Z",
            source: "rejected",
            delivery: { kind: "rejected", reason: "agent busy" },
          },
        ],
        expectedDelivery: null,
      },
    ] as const;

    for (const { name, input, expectedEntries, expectedDelivery } of cases) {
      const outbox = derivePromptOutbox(input);
      expect(outbox.entries, name).toMatchObject(expectedEntries);
      expect(outbox.queuedEntries.length, name).toBe(input.queued.length);
      expect(outbox.rejectedEntries.length, name).toBe(input.rejected.length);
      expect(outbox.legacy.queuedDelivery, name).toBe(expectedDelivery);
      expect(outbox.pendingCount, name).toBe(input.queued.length + input.rejected.length);
      expect(outbox.hasPendingFeedback, name).toBe(outbox.pendingCount > 0);
      expect(outbox.legacy.queued[0], name).toBe(input.queued[0]);
      expect(outbox.legacy.rejected[0], name).toBe(input.rejected[0]);
    }
  });
});
