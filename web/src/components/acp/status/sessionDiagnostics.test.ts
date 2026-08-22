import { describe, expect, it } from "vitest";

import { emptyAcpState } from "../../../lib/acpTypes";
import { deriveSessionDiagnostics, type SessionDiagnosticsInput } from "./sessionDiagnostics";

function input(changes: Partial<SessionDiagnosticsInput> = {}): SessionDiagnosticsInput {
  return {
    state: emptyAcpState(),
    workerState: "running",
    sessionStatus: "Running",
    dormant: false,
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
        name: "persisted stop outranks stale idle-stop replay after restart",
        changes: {
          workerState: "absent",
          sessionStatus: "Stopped",
          state: { ...emptyAcpState(), workerIdleStopped: true },
        },
        expected: { runtime: { kind: "stopped", reason: "user_stopped" } },
      },
      {
        name: "running supervisor outranks a lagging stopped REST poll",
        changes: { workerState: "running", sessionStatus: "Stopped" },
        expected: { runtime: { kind: "ready" } },
      },
      {
        name: "resuming supervisor outranks a lagging stopped REST poll",
        changes: { workerState: "resuming", sessionStatus: "Stopped" },
        expected: { runtime: { kind: "restarting", reason: "manual_restart" } },
      },
      {
        name: "idle reaping is dormant rather than stopped",
        changes: { state: { ...emptyAcpState(), workerIdleStopped: true }, workerState: "absent" },
        expected: { runtime: { kind: "dormant", reason: "idle_auto_stop" } },
      },
      {
        name: "server-owned dormancy fills a missing replay observation",
        changes: { workerState: "absent", dormant: true },
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
        name: "an elicitation suppresses other active turn detail",
        changes: {
          state: {
            ...emptyAcpState(),
            turnActive: true,
            thinking: true,
            pendingElicitations: [{} as never],
          },
        },
        expected: { turn: { kind: "awaiting_user", request: "elicitation" } },
      },
      {
        name: "tool activity retains the display label",
        changes: {
          state: { ...emptyAcpState(), turnActive: true, inFlightTool: { name: "Read file" } as never },
        },
        expected: { turn: { kind: "running", activity: "tool", tool: "Read file" } },
      },
      {
        name: "cancellation retains the escalation deadline",
        changes: {
          state: {
            ...emptyAcpState(),
            turnActive: true,
            cancelling: true,
            cancelEscalatesAt: "2026-08-16T11:00:00Z",
          },
        },
        expected: { turn: { kind: "cancelling", escalatesAt: "2026-08-16T11:00:00Z" } },
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
      {
        name: "a monitor retains its description",
        changes: { state: { ...emptyAcpState(), monitorArmed: true, monitorDescription: "Waiting for CI" } },
        expected: { turn: { kind: "monitoring", description: "Waiting for CI" } },
      },
    ];

    for (const { name, changes, expected } of cases) {
      expect(deriveSessionDiagnostics(input(changes)), name).toMatchObject(expected);
    }
  });
});
