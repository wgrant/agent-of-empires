import { describe, expect, it } from "vitest";

import { emptyAcpState } from "../../../lib/acpTypes";
import {
  deriveSessionDiagnostics,
  deriveTerminalOperationalState,
  type SessionDiagnosticsInput,
} from "./sessionDiagnostics";

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
        expected: { operational: { kind: "active", agent: { kind: "online", turn: { kind: "idle" } } } },
      },
      {
        name: "bare worker absence is unknown rather than progress",
        changes: { workerState: "absent" },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "unknown", detail: "No worker is running and no start is in progress." },
          },
        },
      },
      {
        name: "persisted stop outranks stale idle-stop replay after restart",
        changes: {
          workerState: "absent",
          sessionStatus: "Stopped",
          state: { ...emptyAcpState(), workerIdleStopped: true },
        },
        expected: { operational: { kind: "active", agent: { kind: "stopped", cause: "user" } } },
      },
      {
        name: "running supervisor outranks a lagging stopped REST poll",
        changes: { workerState: "running", sessionStatus: "Stopped" },
        expected: { operational: { kind: "active", agent: { kind: "online" } } },
      },
      {
        name: "bare supervisor resume is a start rather than a restart",
        changes: { workerState: "resuming", sessionStatus: "Stopped" },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "transitioning", operation: "start" },
          },
        },
      },
      {
        name: "idle reaping is dormant rather than stopped",
        changes: { state: { ...emptyAcpState(), workerIdleStopped: true }, workerState: "absent" },
        expected: { operational: { kind: "active", agent: { kind: "dormant", cause: "idle" } } },
      },
      {
        name: "server-owned dormancy fills a missing replay observation",
        changes: { workerState: "absent", dormant: true },
        expected: { operational: { kind: "active", agent: { kind: "dormant", cause: "idle" } } },
      },
      {
        name: "a stale user stop does not outrank a running supervisor",
        changes: { state: { ...emptyAcpState(), workerStopped: true } },
        expected: { operational: { kind: "active", agent: { kind: "online" } } },
      },
      {
        name: "a stopping worker remains transitional",
        changes: { state: { ...emptyAcpState(), workerStopped: true }, workerState: "stopping" },
        expected: { operational: { kind: "active", agent: { kind: "transitioning", operation: "stop" } } },
      },
      {
        name: "restart causes retain their recovery meaning",
        changes: {
          workerState: "resuming",
          state: { ...emptyAcpState(), agentOrphaned: true, workerRestarting: true },
        },
        expected: {
          operational: { kind: "active", agent: { kind: "transitioning", operation: "recover" } },
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
        },
      },
      {
        name: "a provider limit blocks an otherwise running worker",
        changes: {
          state: { ...emptyAcpState(), rateLimit: { kind: "rate_limit", status: "later", resets_at: null } },
        },
        expected: {
          operational: { kind: "active", agent: { kind: "online", condition: { kind: "rate_limited" } } },
        },
      },
      {
        name: "trash structurally hides stale agent and turn evidence",
        changes: { trashedAt: "2026-08-16T10:00:00Z", state: { ...emptyAcpState(), workerStopped: true } },
        expected: {
          operational: { kind: "trashed", trashedAt: "2026-08-16T10:00:00Z" },
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
        },
      },
      {
        name: "a running supervisor does not hide an uncleared handshake failure",
        changes: {
          workerState: "running",
          sessionStatus: "Error",
          state: { ...emptyAcpState(), startupError: "initialize failed" },
        },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "failed", category: "startup", message: "initialize failed" },
          },
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
        },
      },
      {
        name: "an approval is current turn state rather than an agent failure",
        changes: { state: { ...emptyAcpState(), pendingApprovals: [{} as never] } },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "online", turn: { kind: "awaiting_user", request: "approval" } },
          },
        },
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
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "online", turn: { kind: "awaiting_user", request: "elicitation" } },
          },
        },
      },
      {
        name: "tool activity retains the display label",
        changes: {
          state: { ...emptyAcpState(), turnActive: true, inFlightTool: { name: "Read file" } as never },
        },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "online", turn: { kind: "running", activity: "tool", tool: "Read file" } },
          },
        },
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
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "online", turn: { kind: "cancelling", escalatesAt: "2026-08-16T11:00:00Z" } },
          },
        },
      },
      {
        name: "compaction owns active turn state",
        changes: { state: { ...emptyAcpState(), turnActive: true, compacting: true } },
        expected: { operational: { kind: "active", agent: { kind: "online", turn: { kind: "compacting" } } } },
      },
      {
        name: "a scheduled wake remains distinct from idle",
        changes: { state: { ...emptyAcpState(), nextWakeupAt: "2026-08-16T12:00:00Z", nextWakeupReason: "check CI" } },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "online", turn: { kind: "scheduled", wakeAt: "2026-08-16T12:00:00Z", reason: "check CI" } },
          },
        },
      },
      {
        name: "a monitor retains its description",
        changes: { state: { ...emptyAcpState(), monitorArmed: true, monitorDescription: "Waiting for CI" } },
        expected: {
          operational: {
            kind: "active",
            agent: { kind: "online", turn: { kind: "monitoring", description: "Waiting for CI" } },
          },
        },
      },
    ];

    for (const { name, changes, expected } of cases) {
      expect(deriveSessionDiagnostics(input(changes)), name).toMatchObject(expected);
    }

    const terminalBase = {
      sessionStatus: "Idle" as const,
      lastError: null,
      archivedAt: null,
      snoozedUntil: null,
      trashedAt: null,
      ensureState: "ready" as const,
      ensureError: null,
      connected: false,
    };
    const terminalCases = [
      [
        "ensure in progress",
        { ensureState: "pending" as const },
        { kind: "active", agent: { kind: "transitioning", operation: "start" } },
      ],
      [
        "ensure failure",
        { ensureState: "error" as const, ensureError: "tmux unavailable" },
        { kind: "active", agent: { kind: "failed", message: "tmux unavailable" } },
      ],
      ["connected terminal", { connected: true }, { kind: "active", agent: { kind: "online" } }],
      ["stopped terminal", { sessionStatus: "Stopped" as const }, { kind: "active", agent: { kind: "stopped" } }],
      ["unobserved terminal", {}, { kind: "active", agent: { kind: "unknown" } }],
    ] as const;
    for (const [name, changes, expected] of terminalCases) {
      expect(deriveTerminalOperationalState({ ...terminalBase, ...changes }), name).toMatchObject(expected);
    }
  });
});
