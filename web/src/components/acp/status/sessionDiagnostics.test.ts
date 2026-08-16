import { describe, expect, it } from "vitest";

import { emptyAcpState } from "../../../lib/acpTypes";
import { deriveSessionDiagnostics, type SessionDiagnosticsInput } from "./sessionDiagnostics";

function input(changes: Partial<SessionDiagnosticsInput> = {}): SessionDiagnosticsInput {
  return {
    state: emptyAcpState(),
    workerState: "running",
    archivedAt: null,
    snoozedUntil: null,
    trashedAt: null,
    ...changes,
  };
}

describe("ACP session diagnostics", () => {
  it("normalizes lifecycle facts without conflating session disposition, runtime, and turn state", () => {
    const cases: Array<{
      name: string;
      changes: Partial<SessionDiagnosticsInput>;
      expected: Partial<ReturnType<typeof deriveSessionDiagnostics>>;
    }> = [
      {
        name: "healthy ready session",
        changes: {},
        expected: { disposition: { kind: "live" }, runtime: { kind: "ready" }, turn: { kind: "idle" } },
      },
      {
        name: "cold worker is starting",
        changes: { workerState: "absent" },
        expected: { runtime: { kind: "starting" } },
      },
      {
        name: "idle reaping is dormant rather than stopped",
        changes: { state: { ...emptyAcpState(), workerIdleStopped: true }, workerState: "absent" },
        expected: { runtime: { kind: "dormant", reason: "idle_auto_stop" } },
      },
      {
        name: "a user stop is distinct from automatic recovery",
        changes: { state: { ...emptyAcpState(), workerStopped: true } },
        expected: { runtime: { kind: "stopped", reason: "user_stopped" } },
      },
      {
        name: "a stopping worker remains transitional",
        changes: { state: { ...emptyAcpState(), workerStopped: true }, workerState: "stopping" },
        expected: { runtime: { kind: "stopping" } },
      },
      {
        name: "restart causes retain their recovery meaning",
        changes: { state: { ...emptyAcpState(), agentOrphaned: true, workerRestarting: true } },
        expected: { runtime: { kind: "restarting", reason: "prompt_orphaned" } },
      },
      {
        name: "a provider limit blocks an otherwise running worker",
        changes: {
          state: { ...emptyAcpState(), rateLimit: { kind: "rate_limit", status: "later", resets_at: null } },
        },
        expected: { runtime: { kind: "blocked", reason: "rate_limited" } },
      },
      {
        name: "trash takes disposition precedence without rewriting runtime",
        changes: { trashedAt: "2026-08-16T10:00:00Z", state: { ...emptyAcpState(), workerStopped: true } },
        expected: {
          disposition: { kind: "trashed", trashedAt: "2026-08-16T10:00:00Z" },
          runtime: { kind: "stopped", reason: "user_stopped" },
        },
      },
      {
        name: "an approval is current turn state rather than an agent failure",
        changes: { state: { ...emptyAcpState(), pendingApprovals: [{} as never] } },
        expected: { turn: { kind: "awaiting_user", request: "approval" } },
      },
      {
        name: "compaction owns active turn state",
        changes: { state: { ...emptyAcpState(), turnActive: true, compacting: true } },
        expected: { turn: { kind: "compacting" } },
      },
      {
        name: "a scheduled wake remains distinct from idle",
        changes: { state: { ...emptyAcpState(), nextWakeupAt: "2026-08-16T12:00:00Z", nextWakeupReason: "check CI" } },
        expected: { turn: { kind: "scheduled", wakeAt: "2026-08-16T12:00:00Z", reason: "check CI" } },
      },
    ];

    for (const { name, changes, expected } of cases) {
      expect(deriveSessionDiagnostics(input(changes)), name).toMatchObject(expected);
    }
  });
});
