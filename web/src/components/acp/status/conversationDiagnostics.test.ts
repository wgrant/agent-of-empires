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
  it("uses slot-local lifecycle precedence and one composer policy", () => {
    const cases = [
      [snapshot(), null, "send_now"],
      [snapshot({ trashedAt: "2026-08-16T10:00:00Z" }), "trashed", "read_only"],
      [snapshot({ archivedAt: "2026-08-16T10:00:00Z" }), "archived", "resume_then_send"],
      [snapshot({ state: { ...emptyAcpState(), startupError: "binary missing" } }), "failed", "blocked"],
      [snapshot({ state: { ...emptyAcpState(), workerStopped: true } }), "stopped", "resume_then_send"],
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
    ] as const;

    for (const [current, incident, composer] of cases) {
      expect(deriveSessionIncident(current)?.kind ?? null).toBe(incident);
      expect(deriveComposerAvailability(current).kind).toBe(composer);
    }
  });
});
