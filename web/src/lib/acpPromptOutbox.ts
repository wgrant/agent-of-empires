import type { QueuedPrompt, RejectedPrompt } from "./acpTypes";

export type PromptOutboxDelivery = "ready_after_turn" | "waiting_for_recovery";

export type PromptDeliveryState =
  | {
      kind: "queued";
      until: "turn_complete" | "agent_ready";
      reason: string;
    }
  | {
      kind: "rejected";
      reason: string;
    };

/** One prompt that has left the composer but still needs user-visible delivery
 * feedback. `prompt` is the existing reducer-owned object, not a second copy. */
export type PromptOutboxEntry =
  | {
      id: string;
      text: string;
      createdAt: string;
      source: "queued";
      prompt: QueuedPrompt;
      delivery: Extract<PromptDeliveryState, { kind: "queued" }>;
    }
  | {
      id: string;
      text: string;
      createdAt: string;
      source: "rejected";
      prompt: RejectedPrompt;
      delivery: Extract<PromptDeliveryState, { kind: "rejected" }>;
    };

export type QueuedPromptOutboxEntry = Extract<PromptOutboxEntry, { source: "queued" }>;
export type RejectedPromptOutboxEntry = Extract<PromptOutboxEntry, { source: "rejected" }>;

/** Temporary projection for the existing queue and rejection strips. Keeping
 * it explicit lets those components retain their props while classification
 * and delivery meaning live in the outbox adapter. */
export interface LegacyPromptOutboxProjection {
  queued: QueuedPrompt[];
  rejected: RejectedPrompt[];
  queuedDelivery: PromptOutboxDelivery | null;
}

export interface PromptOutbox {
  entries: PromptOutboxEntry[];
  queuedEntries: QueuedPromptOutboxEntry[];
  rejectedEntries: RejectedPromptOutboxEntry[];
  legacy: LegacyPromptOutboxProjection;
  pendingCount: number;
  hasPendingFeedback: boolean;
}

const QUEUED_REASONS = {
  turn_complete: "The agent is finishing the current turn.",
  agent_ready: "The agent must recover before this prompt can be sent.",
} as const;

export function derivePromptOutbox(input: {
  queued: QueuedPrompt[];
  rejected: RejectedPrompt[];
  waitingForRecovery: boolean;
}): PromptOutbox {
  const until = input.waitingForRecovery ? "agent_ready" : "turn_complete";
  const queuedEntries: QueuedPromptOutboxEntry[] = input.queued.map((prompt): QueuedPromptOutboxEntry => ({
    id: prompt.id,
    text: prompt.text,
    createdAt: prompt.queuedAt,
    source: "queued",
    prompt,
    delivery: { kind: "queued", until, reason: QUEUED_REASONS[until] },
  }));
  const rejectedEntries: RejectedPromptOutboxEntry[] = input.rejected.map((prompt): RejectedPromptOutboxEntry => ({
    id: prompt.id,
    text: prompt.text,
    createdAt: prompt.rejectedAt,
    source: "rejected",
    prompt,
    delivery: { kind: "rejected", reason: prompt.reason },
  }));
  const entries: PromptOutboxEntry[] = [...queuedEntries, ...rejectedEntries];
  const queued = queuedEntries.map((entry) => entry.prompt);
  const rejected = rejectedEntries.map((entry) => entry.prompt);

  return {
    entries,
    queuedEntries,
    rejectedEntries,
    legacy: {
      queued,
      rejected,
      queuedDelivery:
        queued.length === 0 ? null : input.waitingForRecovery ? "waiting_for_recovery" : "ready_after_turn",
    },
    pendingCount: entries.length,
    hasPendingFeedback: entries.length > 0,
  };
}
