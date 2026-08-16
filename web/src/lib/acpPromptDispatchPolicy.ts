/**
 * Existing observations used to decide whether an ACP prompt can be posted
 * immediately. This deliberately does not probe anything: callers provide
 * their current WebSocket, worker, and turn observations.
 */
export interface PromptDispatchPolicyInput {
  transportOpen: boolean;
  workerState: "absent" | "resuming" | "running" | "stopping";
  workerStopped: boolean;
  workerRestarting: boolean;
  workerIdleStopped: boolean;
  turnActive: boolean;
  canSteer: boolean;
  cancelling: boolean;
  compacting: boolean;
}

export type PromptDispatchPolicy =
  | { kind: "dispatch" }
  | { kind: "dispatch_wake" }
  | { kind: "queue"; reason: "transport" | "worker" | "turn" };

/**
 * Select the one immediate action for a new or queued prompt. An idle-reaped
 * worker is deliberately a wake path rather than an unavailable worker: the
 * prompt POST itself asks the daemon to respawn it. A steerable active turn
 * also dispatches immediately, except while cancellation or compaction owns
 * the turn.
 */
export function derivePromptDispatchPolicy(input: PromptDispatchPolicyInput): PromptDispatchPolicy {
  if (!input.transportOpen) return { kind: "queue", reason: "transport" };
  if (input.workerStopped || input.workerRestarting) return { kind: "queue", reason: "worker" };

  const turnBlocks = input.turnActive && !(input.canSteer && !input.cancelling && !input.compacting);
  if (turnBlocks) return { kind: "queue", reason: "turn" };

  if (input.workerIdleStopped) return { kind: "dispatch_wake" };
  if (input.workerState !== "running") return { kind: "queue", reason: "worker" };
  return { kind: "dispatch" };
}

/** A queued batch may be drained only when it follows the same immediate
 * policy as a newly-submitted prompt. */
export function canDrainQueuedPrompt(input: PromptDispatchPolicyInput): boolean {
  return derivePromptDispatchPolicy(input).kind !== "queue";
}
