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
        name: "bare worker absence is unknown rather than progress",
        changes: { workerState: "absent" },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "unknown", detail: "No worker is running and no start is in progress." },
          },
          runtime: { kind: "unknown" },
        },
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
        name: "bare supervisor resume is a start rather than a restart",
        changes: { workerState: "resuming", sessionStatus: "Stopped" },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "transitioning", operation: "start" },
          },
          runtime: { kind: "starting" },
        },
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
        name: "a stale user stop does not outrank a running supervisor",
        changes: { state: { ...emptyAcpState(), workerStopped: true } },
        expected: { operational: { kind: "active", agent: { kind: "online" } }, runtime: { kind: "ready" } },
      },
      {
        name: "a stopping worker remains transitional",
        changes: { state: { ...emptyAcpState(), workerStopped: true }, workerState: "stopping" },
        expected: { runtime: { kind: "stopping" } },
      },
      {
        name: "restart causes retain their recovery meaning",
        changes: {
          workerState: "resuming",
          state: { ...emptyAcpState(), agentOrphaned: true, workerRestarting: true },
        },
        expected: {
          operational: { kind: "active", agent: { kind: "transitioning", operation: "recover" } },
          runtime: { kind: "restarting", reason: "prompt_orphaned" },
        },
      },
      {
        name: "explicit restart intent distinguishes restart from start",
        changes: {
          workerState: "resuming",
          state: { ...emptyAcpState(), workerRestarting: true },
        },
        expected: {
          operational: { kind: "active", agent: { kind: "transitioning", operation: "restart" } },
          runtime: { kind: "restarting", reason: "manual_restart" },
        },
      },
      {
        name: "a provider limit blocks an otherwise running worker",
        changes: {
          state: { ...emptyAcpState(), rateLimit: { kind: "rate_limit", status: "later", resets_at: null } },
        },
        expected: { runtime: { kind: "blocked", reason: "rate_limited" } },
      },
      {
        name: "trash structurally hides stale agent and turn evidence",
        changes: { trashedAt: "2026-08-16T10:00:00Z", state: { ...emptyAcpState(), workerStopped: true } },
        expected: {
          operational: { kind: "trashed", trashedAt: "2026-08-16T10:00:00Z" },
          disposition: { kind: "trashed", trashedAt: "2026-08-16T10:00:00Z" },
          runtime: { kind: "unknown" },
          turn: { kind: "idle" },
        },
      },
      {
        name: "server startup failure is retained when replay has no error",
        changes: {
          workerState: "absent",
          sessionStatus: "Error",
          lastError: "adapter exited before initialize",
        },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "failed", category: "startup", message: "adapter exited before initialize" },
          },
          runtime: { kind: "failed", category: "startup", message: "adapter exited before initialize" },
        },
      },
      {
        name: "accepted stop outranks a briefly live old worker",
        changes: {
          pendingOperation: {
            kind: "stop",
            stage: "accepted",
            startedAt: "2026-08-16T10:30:00Z",
            operationId: "stop-1",
            error: null,
          },
        },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "transitioning", operation: "stop", operationId: "stop-1" },
          },
        },
      },
      {
        name: "accepted start outranks stale stopped observations",
        changes: {
          workerState: "absent",
          sessionStatus: "Stopped",
          state: { ...emptyAcpState(), workerStopped: true },
          pendingOperation: {
            kind: "start",
            stage: "accepted",
            startedAt: "2026-08-16T10:31:00Z",
            operationId: "start-1",
            error: null,
          },
        },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "transitioning", operation: "start", operationId: "start-1" },
          },
          runtime: { kind: "starting" },
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
