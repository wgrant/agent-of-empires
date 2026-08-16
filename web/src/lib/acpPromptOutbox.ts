import type { QueuedPrompt, RejectedPrompt } from "./acpTypes";

export type PromptOutboxDelivery = "ready_after_turn" | "waiting_for_recovery";

/**
 * A presentation-facing view of prompts which have left the composer but have
 * not reached their final transcript state. The reducer remains authoritative
 * for now: this selector deliberately preserves the separate queued and
 * rejected collections while keeping their shared lifecycle in one place.
 */
export interface PromptOutbox {
  queued: QueuedPrompt[];
  rejected: RejectedPrompt[];
  queuedDelivery: PromptOutboxDelivery | null;
  pendingCount: number;
  hasPendingFeedback: boolean;
}

export function derivePromptOutbox(input: {
  queued: QueuedPrompt[];
  rejected: RejectedPrompt[];
  waitingForRecovery: boolean;
}): PromptOutbox {
  return {
    queued: input.queued,
    rejected: input.rejected,
    queuedDelivery:
      input.queued.length === 0 ? null : input.waitingForRecovery ? "waiting_for_recovery" : "ready_after_turn",
    pendingCount: input.queued.length + input.rejected.length,
    hasPendingFeedback: input.queued.length > 0 || input.rejected.length > 0,
  };
}
