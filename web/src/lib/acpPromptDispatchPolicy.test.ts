import { describe, expect, it } from "vitest";

import { derivePromptDispatchPolicy } from "./acpPromptDispatchPolicy";

const ready = {
  transportOpen: true,
  workerState: "running" as const,
  workerStopped: false,
  workerRestarting: false,
  workerIdleStopped: false,
  turnActive: false,
  canSteer: false,
  cancelling: false,
  compacting: false,
};

describe("ACP prompt dispatch policy", () => {
  it("preserves the transport, worker, and turn gates", () => {
    const cases = [
      [{}, "dispatch"],
      [{ transportOpen: false }, "queue"],
      [{ workerState: "resuming" }, "queue"],
      [{ workerStopped: true }, "queue"],
      [{ workerRestarting: true }, "queue"],
      [{ workerIdleStopped: true, workerState: "absent" }, "dispatch_wake"],
      [{ turnActive: true }, "queue"],
      [{ turnActive: true, canSteer: true }, "dispatch"],
      [{ turnActive: true, canSteer: true, cancelling: true }, "queue"],
      [{ turnActive: true, canSteer: true, compacting: true }, "queue"],
    ] as const;

    for (const [changes, expected] of cases) {
      expect(derivePromptDispatchPolicy({ ...ready, ...changes }).kind).toBe(expected);
    }
  });
});
