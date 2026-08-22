import { describe, expect, it } from "vitest";

import { deriveConversationNextStep, deriveConversationStatus, type ConversationStatus } from "./conversationStatus";
import type { ConversationSyncStatus } from "./conversationSyncStatus";
import type { TurnExecution } from "./sessionDiagnostics";

describe("deriveConversationNextStep", () => {
  it("uses one priority order for history, recovery, and turn activity", () => {
    const idleStatus: ConversationStatus = {
      kind: "idle",
      tone: "neutral",
      placement: null,
      composer: "available",
    };
    const activeStatus: ConversationStatus = {
      kind: "active",
      cause: "working",
      tone: "neutral",
      placement: "transcript_tail",
      composer: "queue",
    };
    const recoveryStatus: ConversationStatus = {
      kind: "updating",
      cause: "agent_restarting",
      tone: "progress",
      placement: "session",
      composer: "queue",
    };
    const working = {
      kind: "working",
      thinking: false,
      tool: null,
      cancelling: false,
      cancelEscalatesAt: null,
      compacting: false,
    } as const;
    const cases: Array<{
      name: string;
      sync: ConversationSyncStatus;
      status: ConversationStatus;
      turn: TurnExecution;
      expected: ReturnType<typeof deriveConversationNextStep>;
    }> = [
      {
        name: "initial catch-up outranks recovery",
        sync: "initial",
        status: recoveryStatus,
        turn: { kind: "running", activity: "waiting", tool: null },
        expected: { kind: "catching_up" },
      },
      {
        name: "history loading suppresses cached work",
        sync: "history",
        status: activeStatus,
        turn: { kind: "running", activity: "waiting", tool: null },
        expected: { kind: "catching_up" },
      },
      {
        name: "recovery suppresses stale work",
        sync: "idle",
        status: recoveryStatus,
        turn: { kind: "running", activity: "thinking", tool: null },
        expected: null,
      },
      {
        name: "approval card stands alone",
        sync: "idle",
        status: activeStatus,
        turn: { kind: "awaiting_user", request: "approval" },
        expected: null,
      },
      {
        name: "elicitation card stands alone",
        sync: "idle",
        status: activeStatus,
        turn: { kind: "awaiting_user", request: "elicitation" },
        expected: null,
      },
      {
        name: "thinking annotates work",
        sync: "idle",
        status: activeStatus,
        turn: { kind: "running", activity: "thinking", tool: null },
        expected: { ...working, thinking: true },
      },
      {
        name: "tool activity retains its label",
        sync: "idle",
        status: activeStatus,
        turn: { kind: "running", activity: "tool", tool: "Read file" },
        expected: { ...working, tool: "Read file" },
      },
      {
        name: "cancellation retains escalation",
        sync: "idle",
        status: activeStatus,
        turn: { kind: "cancelling", escalatesAt: "2026-08-22T04:00:00Z" },
        expected: { ...working, cancelling: true, cancelEscalatesAt: "2026-08-22T04:00:00Z" },
      },
      {
        name: "compaction owns work",
        sync: "idle",
        status: activeStatus,
        turn: { kind: "compacting" },
        expected: { ...working, compacting: true },
      },
      {
        name: "scheduled wake carries its detail",
        sync: "idle",
        status: idleStatus,
        turn: { kind: "scheduled", wakeAt: "2026-08-22T05:00:00Z", reason: "check build" },
        expected: { kind: "scheduled_wakeup", wakeAt: "2026-08-22T05:00:00Z", reason: "check build" },
      },
      {
        name: "monitor carries its detail",
        sync: "idle",
        status: idleStatus,
        turn: { kind: "monitoring", description: "Waiting for CI" },
        expected: { kind: "monitoring", description: "Waiting for CI" },
      },
      { name: "idle has no tail status", sync: "idle", status: idleStatus, turn: { kind: "idle" }, expected: null },
    ];

    for (const { name, expected, ...input } of cases) {
      expect(deriveConversationNextStep(input), name).toEqual(expected);
    }
  });
});

describe("deriveConversationStatus", () => {
  it("uses one priority order for lifecycle, synchronization, and agent activity", () => {
    const cases = [
      [
        { agentSession: "failed", sync: "reconnect", turnActive: true, nextWakeupAt: "x", monitorArmed: true },
        "blocked",
        "agent_failed",
        "session",
      ],
      [
        { agentSession: "rate_limited", sync: "reconnect", turnActive: true, nextWakeupAt: null, monitorArmed: false },
        "blocked",
        "rate_limited",
        "session",
      ],
      [
        { agentSession: "restarting", sync: "reconnect", turnActive: true, nextWakeupAt: null, monitorArmed: false },
        "updating",
        "agent_restarting",
        "session",
      ],
      [
        { agentSession: "ready", sync: "initial", turnActive: true, nextWakeupAt: null, monitorArmed: false },
        "updating",
        "initial",
        "session",
      ],
      [
        { agentSession: "ready", sync: "reconnect", turnActive: true, nextWakeupAt: null, monitorArmed: false },
        "updating",
        "reconnect",
        "composer",
      ],
      [
        { agentSession: "ready", sync: "idle", turnActive: true, nextWakeupAt: "x", monitorArmed: true },
        "active",
        "working",
        "transcript_tail",
      ],
      [
        { agentSession: "ready", sync: "idle", turnActive: false, nextWakeupAt: "x", monitorArmed: true },
        "waiting",
        "scheduled_wakeup",
        "transcript_tail",
      ],
      [
        { agentSession: "ready", sync: "history", turnActive: false, nextWakeupAt: null, monitorArmed: true },
        "waiting",
        "monitoring",
        "transcript_tail",
      ],
    ] as const;
    for (const [input, kind, cause, placement] of cases) {
      expect(deriveConversationStatus(input)).toMatchObject({ kind, cause, placement });
    }
  });
});
