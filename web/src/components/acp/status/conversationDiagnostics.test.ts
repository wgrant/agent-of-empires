import { describe, expect, it } from "vitest";

import { emptyAcpState } from "../../../lib/acpTypes";
import type { ConnectionStatusSnapshot } from "./connectionStatus";
import {
  deriveComposerAvailability,
  deriveSessionIncident,
  type ConversationDiagnosticsSnapshot,
} from "./conversationDiagnostics";
import { deriveSessionDiagnostics } from "./sessionDiagnostics";

const connection: ConnectionStatusSnapshot = {
  dashboard: { phase: "connected", lastSuccessAt: null, failureSince: null },
  session: null,
};

function snapshot(
  changes: Parameters<typeof deriveSessionDiagnostics>[0] = {} as never,
): ConversationDiagnosticsSnapshot {
  const lifecycle = deriveSessionDiagnostics({
    state: emptyAcpState(),
    workerState: "running",
    archivedAt: null,
    snoozedUntil: null,
    trashedAt: null,
    ...changes,
  });
  return { connection, session: { sessionId: "s1", kind: "structured", lifecycle } };
}

describe("conversation diagnostics selectors", () => {
  it("selects complete lifecycle presentation payloads", () => {
    const restartCases = [
      {
        state: { ...emptyAcpState(), workerRestarting: true },
        reason: "manual_restart",
        detail:
          "Restarting structured view worker… the daemon will respawn the agent with your existing transcript shortly.",
      },
      {
        state: { ...emptyAcpState(), agentUnresponsive: true },
        reason: "cancel_unresponsive",
        detail: "Agent stopped responding to cancel. Restarting worker; your transcript will be preserved.",
      },
      {
        state: { ...emptyAcpState(), agentUnresponsive: true, agentOrphaned: true },
        reason: "prompt_orphaned",
        detail: "Agent finished but didn't notify the daemon. Restarting worker; your transcript will be preserved.",
      },
    ] as const;
    for (const { state, reason, detail } of restartCases) {
      expect(deriveSessionIncident(snapshot({ state, workerState: "resuming" }))).toMatchObject({
        kind: "restarting",
        action: "wait",
        reason,
        detail,
      });
    }

    expect(deriveSessionIncident(snapshot({ snoozedUntil: "2099-01-01T09:30:00Z" }))).toMatchObject({
      kind: "snoozed",
      action: "unsnooze",
      snoozedUntil: "2099-01-01T09:30:00Z",
    });
    expect(
      deriveSessionIncident(snapshot({ state: { ...emptyAcpState(), startupError: "binary missing" } })),
    ).toMatchObject({
      kind: "failed",
      action: "retry_start",
      category: "startup",
      detail: "binary missing",
    });
  });

  it("uses slot-local lifecycle precedence and one composer policy", () => {
    const cases = [
      [snapshot(), null, "send_now"],
      [snapshot({ trashedAt: "2026-08-16T10:00:00Z" }), "trashed", "read_only"],
      [snapshot({ archivedAt: "2026-08-16T10:00:00Z" }), "archived", "resume_then_send"],
      [snapshot({ state: { ...emptyAcpState(), startupError: "binary missing" } }), "failed", "blocked"],
      [snapshot({ state: { ...emptyAcpState(), workerStopped: true } }), "stopped", "queue_for_recovery"],
      [snapshot({ workerState: "stopping" }), "stopping", "queue_for_recovery"],
      [
        snapshot({
          state: { ...emptyAcpState(), rateLimit: { kind: "rate_limit", status: "later", resets_at: null } },
        }),
        "blocked",
        "blocked",
      ],
      [
        snapshot({ state: { ...emptyAcpState(), workerRestarting: true }, workerState: "resuming" }),
        "restarting",
        "queue_for_recovery",
      ],
      [
        snapshot({ state: { ...emptyAcpState(), workerIdleStopped: true }, workerState: "absent" }),
        "dormant",
        "wake_agent",
      ],
      [snapshot({ state: { ...emptyAcpState(), turnActive: true, compacting: true } }), null, "queue_after_turn"],
      [snapshot({ state: { ...emptyAcpState(), turnActive: true } }), null, "queue_after_turn"],
      [
        snapshot({
          state: {
            ...emptyAcpState(),
            turnActive: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false, steering: true },
          },
        }),
        null,
        "steer_now",
      ],
    ] as const;

    for (const [current, incident, composer] of cases) {
      expect(deriveSessionIncident(current)?.kind ?? null).toBe(incident);
      expect(deriveComposerAvailability(current).kind).toBe(composer);
    }
  });
});
