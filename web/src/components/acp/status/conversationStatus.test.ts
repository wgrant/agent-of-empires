import { describe, expect, it } from "vitest";

import { deriveConversationNextStep, runtimeAllowsConversationTail } from "./conversationStatus";
import type { AgentRuntime, SessionDiagnostics, TurnExecution } from "./sessionDiagnostics";

const evidence: SessionDiagnostics["evidence"] = {
  workerState: "running",
  startupError: null,
  incompatibleAgent: null,
  rateLimit: null,
  workerStopped: false,
  workerRestarting: false,
  workerIdleStopped: false,
  agentUnresponsive: false,
  agentOrphaned: false,
  canSteer: false,
};

function diagnostics(runtime: AgentRuntime, turn: TurnExecution): SessionDiagnostics {
  return { disposition: { kind: "live" }, runtime, turn, evidence };
}

describe("deriveConversationNextStep", () => {
  it("allows tail state only for a ready runtime", () => {
    const runtimes: Array<[AgentRuntime, boolean]> = [
      [{ kind: "unknown" }, false],
      [{ kind: "starting" }, false],
      [{ kind: "ready" }, true],
      [{ kind: "dormant", reason: "idle_auto_stop" }, false],
      [{ kind: "restarting", reason: "manual_restart" }, false],
      [{ kind: "stopped", reason: "user_stopped" }, false],
      [{ kind: "blocked", reason: "rate_limited" }, false],
      [{ kind: "failed", category: "startup", message: "missing" }, false],
    ];
    for (const [runtime, expected] of runtimes) {
      expect(runtimeAllowsConversationTail(runtime), runtime.kind).toBe(expected);
    }
  });

  it("uses one priority order for catch-up, recovery, runtime, and turn activity", () => {
    const ready: AgentRuntime = { kind: "ready" };
    const restarting: AgentRuntime = { kind: "restarting", reason: "manual_restart" };
    const working = {
      kind: "working",
      thinking: false,
      tool: null,
      cancelling: false,
      cancelEscalatesAt: null,
      compacting: false,
    } as const;
    const cases = [
      [
        "initial catch-up outranks recovery",
        "initial",
        restarting,
        { kind: "running", activity: "waiting", tool: null },
        { kind: "catching_up" },
      ],
      [
        "history loading suppresses cached work",
        "history",
        ready,
        { kind: "running", activity: "waiting", tool: null },
        { kind: "catching_up" },
      ],
      [
        "reconnect suppresses ready work",
        "reconnect",
        ready,
        { kind: "running", activity: "thinking", tool: null },
        null,
      ],
      [
        "recovery suppresses stale work",
        "idle",
        restarting,
        { kind: "running", activity: "thinking", tool: null },
        null,
      ],
      ["approval card stands alone", "idle", ready, { kind: "awaiting_user", request: "approval" }, null],
      ["elicitation card stands alone", "idle", ready, { kind: "awaiting_user", request: "elicitation" }, null],
      [
        "thinking annotates work",
        "idle",
        ready,
        { kind: "running", activity: "thinking", tool: null },
        { ...working, thinking: true },
      ],
      [
        "tool activity retains its label",
        "idle",
        ready,
        { kind: "running", activity: "tool", tool: "Read file" },
        { ...working, tool: "Read file" },
      ],
      [
        "cancellation retains escalation",
        "idle",
        ready,
        { kind: "cancelling", escalatesAt: "2026-08-22T04:00:00Z" },
        { ...working, cancelling: true, cancelEscalatesAt: "2026-08-22T04:00:00Z" },
      ],
      ["compaction owns work", "idle", ready, { kind: "compacting" }, { ...working, compacting: true }],
      [
        "scheduled wake carries its detail",
        "idle",
        ready,
        { kind: "scheduled", wakeAt: "2026-08-22T05:00:00Z", reason: "check build" },
        { kind: "scheduled_wakeup", wakeAt: "2026-08-22T05:00:00Z", reason: "check build" },
      ],
      [
        "monitor carries its detail",
        "idle",
        ready,
        { kind: "monitoring", description: "Waiting for CI" },
        { kind: "monitoring", description: "Waiting for CI" },
      ],
      ["idle has no tail status", "idle", ready, { kind: "idle" }, null],
    ] as const;

    for (const [name, sync, runtime, turn, expected] of cases) {
      expect(deriveConversationNextStep({ sync, diagnostics: diagnostics(runtime, turn) }), name).toEqual(expected);
    }
  });
});
