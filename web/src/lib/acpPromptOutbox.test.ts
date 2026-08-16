import { describe, expect, it } from "vitest";

import { derivePromptOutbox } from "./acpPromptOutbox";

describe("ACP prompt outbox", () => {
  it("keeps queued and rejected prompt feedback together without merging their actions", () => {
    const queued = [{ id: "q1", text: "wait", queuedAt: "2026-08-16T12:00:00Z" }];
    const rejected = [{ id: "r1", text: "retry", reason: "busy", rejectedAt: "2026-08-16T12:00:00Z" }];

    expect(derivePromptOutbox({ queued: [], rejected: [], waitingForRecovery: false })).toMatchObject({
      queuedDelivery: null,
      pendingCount: 0,
      hasPendingFeedback: false,
    });
    expect(derivePromptOutbox({ queued, rejected, waitingForRecovery: true })).toMatchObject({
      queued,
      rejected,
      queuedDelivery: "waiting_for_recovery",
      pendingCount: 2,
      hasPendingFeedback: true,
    });
  });
});
