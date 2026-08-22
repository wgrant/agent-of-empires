import { describe, expect, it } from "vitest";

import { deriveConversationNextStep } from "./conversationStatus";
import type { AgentState, SessionDiagnostics, TurnExecution } from "./sessionDiagnostics";

function diagnostics(agent: AgentState): SessionDiagnostics {
  return { operational: { kind: "active", agent } };
}

function online(turn: TurnExecution): AgentState {
  return { kind: "online", since: null, condition: { kind: "normal" }, turn, canSteer: false };
}

describe("deriveConversationNextStep", () => {
  it("uses one priority order for catch-up, recovery, runtime, and turn activity", () => {
    const restarting: AgentState = {
      kind: "transitioning",
      operation: "restart",
      reason: "manual_restart",
      startedAt: null,
      operationId: null,
    };
    const working = {
      kind: "working",
      thinking: false,
      tool: null,
      cancelling: false,
      cancelEscalatesAt: null,
      compacting: false,
    } as const;
    const cases = [
      ["initial catch-up outranks recovery", "initial", restarting, { kind: "catching_up" }],
      [
        "history loading suppresses cached work",
        "history",
        online({ kind: "running", activity: "waiting", tool: null }),
        { kind: "catching_up" },
      ],
      [
        "reconnect suppresses ready work",
        "reconnect",
        online({ kind: "running", activity: "thinking", tool: null }),
        null,
      ],
      ["recovery suppresses stale work", "idle", restarting, null],
      ["approval card stands alone", "idle", online({ kind: "awaiting_user", request: "approval" }), null],
      ["elicitation card stands alone", "idle", online({ kind: "awaiting_user", request: "elicitation" }), null],
      [
        "thinking annotates work",
        "idle",
        online({ kind: "running", activity: "thinking", tool: null }),
        { ...working, thinking: true },
      ],
      [
        "tool activity retains its label",
        "idle",
        online({ kind: "running", activity: "tool", tool: "Read file" }),
        { ...working, tool: "Read file" },
      ],
      [
        "cancellation retains escalation",
        "idle",
        online({ kind: "cancelling", escalatesAt: "2026-08-22T04:00:00Z" }),
        { ...working, cancelling: true, cancelEscalatesAt: "2026-08-22T04:00:00Z" },
      ],
      ["compaction owns work", "idle", online({ kind: "compacting" }), { ...working, compacting: true }],
      [
        "scheduled wake carries its detail",
        "idle",
        online({ kind: "scheduled", wakeAt: "2026-08-22T05:00:00Z", reason: "check build" }),
        { kind: "scheduled_wakeup", wakeAt: "2026-08-22T05:00:00Z", reason: "check build" },
      ],
      [
        "monitor carries its detail",
        "idle",
        online({ kind: "monitoring", description: "Waiting for CI" }),
        { kind: "monitoring", description: "Waiting for CI" },
      ],
      ["idle has no tail status", "idle", online({ kind: "idle" }), null],
    ] as const;

    for (const [name, sync, agent, expected] of cases) {
      expect(deriveConversationNextStep({ sync, diagnostics: diagnostics(agent) }), name).toEqual(expected);
    }
  });
});
