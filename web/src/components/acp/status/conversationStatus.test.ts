import { describe, expect, it } from "vitest";

import { deriveConversationNextStep, deriveConversationStatus } from "./conversationStatus";

describe("deriveConversationNextStep", () => {
  it("gives transcript catch-up precedence over cached agent activity", () => {
    expect(
      deriveConversationNextStep({ initialCatchup: true, turnActive: true, nextWakeupAt: null, monitorArmed: false }),
    ).toEqual({ kind: "catching_up" });
    expect(
      deriveConversationNextStep({ initialCatchup: false, turnActive: true, nextWakeupAt: null, monitorArmed: false }),
    ).toEqual({ kind: "working" });
    expect(
      deriveConversationNextStep({ initialCatchup: false, turnActive: false, nextWakeupAt: "x", monitorArmed: true }),
    ).toEqual({ kind: "scheduled_wakeup" });
    expect(
      deriveConversationNextStep({ initialCatchup: false, turnActive: false, nextWakeupAt: null, monitorArmed: true }),
    ).toEqual({ kind: "monitoring" });
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
