import { describe, expect, it } from "vitest";

import {
  connectionStatusCompactLabel,
  connectionComposerNotice,
  connectionStatusPresentation,
  deriveConnectionDiagnostics,
  deriveConnectionIncident,
  deriveDashboardConnectionDiagnostics,
  deriveTerminalConnectionDiagnostics,
  selectConnectionDiagnostics,
} from "./connectionStatus";

const base = {
  status: "open" as const,
  serverReachability: "unknown" as const,
  lagged: false,
  rateLimit: null,
  rateLimitRetriesExhausted: false,
  hasEverOpened: true,
  reconnecting: false,
  retryCount: 0,
  retryCountdown: 0,
  maxRetries: 7,
  rateLimitText: () => "Rate-limited (provider); resets at 10:42:00.",
  startupError: false,
  workerStopped: false,
  workerRestarting: false,
  agentUnresponsive: false,
  agentOrphaned: false,
  lastWebSocketOpenAt: null,
  lastServerMessageAt: null,
  lastTransportDiagnostic: null,
  reconnectingSince: null,
  liveUpdatesStale: false,
};

describe("connection status model", () => {
  it("derives primary status from route, session, and continuity in priority order", () => {
    const cases = [
      [{}, "connected", "connected", "ready", "current"],
      [{ workerStopped: true }, "agent_stopped", "connected", "stopped", "current"],
      [{ startupError: true }, "agent_failed", "connected", "failed", "current"],
      [{ agentUnresponsive: true }, "agent_unresponsive", "connected", "unresponsive", "current"],
      [
        { rateLimit: { kind: "provider", status: "later", resets_at: null } },
        "rate_limited",
        "connected",
        "rate_limited",
        "current",
      ],
      [{ workerRestarting: true }, "agent_restarting", "connected", "restarting", "current"],
      [{ lagged: true }, "updates_missed", "connected", "ready", "missed"],
      [{ liveUpdatesStale: true }, "updates_delayed", "connected", "ready", "delayed"],
      [{ serverReachability: "unreachable" as const }, "updates_unavailable", "connected", "ready", "unavailable"],
      [
        { status: "closed" as const, reconnecting: true, workerStopped: true },
        "reconnecting",
        "reconnecting",
        "stopped",
        "unavailable",
      ],
      [
        { status: "closed" as const, retryCount: 7, workerStopped: true },
        "disconnected",
        "disconnected",
        "stopped",
        "unavailable",
      ],
    ] as const;

    for (const [changes, primary, route, session, continuity] of cases) {
      const diagnostics = deriveConnectionDiagnostics({ ...base, ...changes });
      expect(diagnostics).toMatchObject({ primary, route, session, continuity });
    }
  });

  it("retains a known device-to-AoE route while gating downstream session status", () => {
    const diagnostics = deriveConnectionDiagnostics({
      ...base,
      status: "closed",
      reconnecting: true,
      retryCount: 1,
      serverReachability: "reachable",
      workerStopped: true,
    });
    expect(diagnostics).toMatchObject({
      primary: "reconnecting",
      deviceToServer: "ready",
      server: "unknown",
      serverToAgent: "inactive",
      agent: "unknown",
    });
    expect(diagnostics.sections.find((section) => section.id === "agent")?.observations[0]?.value).toBe(
      "Last known: Worker stopped",
    );
  });

  it("uses one presentation mapping for headline, tone, and compact text", () => {
    const stopped = deriveConnectionDiagnostics({ ...base, workerStopped: true });
    expect(connectionStatusPresentation(stopped.primary)).toMatchObject({ headline: "Agent stopped", tone: "error" });
    expect(connectionStatusCompactLabel(stopped)).toBe("Agent stopped");

    const retrying = deriveConnectionDiagnostics({ ...base, status: "closed", reconnecting: true, retryCount: 3 });
    expect(connectionStatusPresentation(retrying.primary)).toMatchObject({
      headline: "Reconnecting",
      tone: "warning",
      working: true,
    });
    expect(connectionStatusCompactLabel(retrying)).toBe("Reconnecting · 3/7");
    expect(connectionComposerNotice(retrying.primary)).toBe(
      "Reconnecting. New messages will wait until this session resumes.",
    );
  });

  it("only creates an incident for a non-connected primary state", () => {
    expect(deriveConnectionIncident(base)).toBeNull();
    expect(deriveConnectionIncident({ ...base, lagged: true })?.primary).toBe("updates_missed");
  });

  it("keeps dashboard and terminal diagnostics in the same route contract", () => {
    expect(deriveDashboardConnectionDiagnostics(false)).toMatchObject({
      targetLabel: null,
      primary: "connected",
      route: "connected",
      hasIncident: false,
    });
    expect(
      deriveTerminalConnectionDiagnostics({
        connected: false,
        reconnecting: true,
        retryCount: 2,
        retryCountdown: 3,
        maxRetries: 7,
      }),
    ).toMatchObject({
      targetLabel: "Terminal",
      primary: "reconnecting",
      route: "reconnecting",
      hasIncident: true,
    });
  });

  it("selects dashboard-only status without a session and gives an AoE outage priority over session state", () => {
    const dashboard = { phase: "connected" as const, lastSuccessAt: 100, failureSince: null };
    expect(selectConnectionDiagnostics({ dashboard, session: null })).toMatchObject({
      targetLabel: null,
      primary: "connected",
    });

    const session = {
      kind: "structured" as const,
      sessionId: "session",
      diagnostics: deriveConnectionDiagnostics({ ...base, workerStopped: true }),
      transport: {
        route: "connected" as const,
        connectedAt: 100,
        lastMessageAt: 100,
        reconnectingSince: null,
        retryCount: 0,
        retryCountdown: 0,
        maxRetries: 7,
        lastFailure: null,
      },
    };
    expect(
      selectConnectionDiagnostics({
        dashboard: { phase: "unavailable", lastSuccessAt: 100, failureSince: 200 },
        session,
      }),
    ).toMatchObject({ primary: "disconnected", deviceToServer: "failed", serverToAgent: "inactive" });
  });

  it("treats a dashboard poll timestamp as evidence, not a connection start time", () => {
    const diagnostics = deriveDashboardConnectionDiagnostics({
      phase: "connected",
      lastSuccessAt: new Date("2026-08-12T13:04:00Z").getTime(),
      failureSince: null,
    });
    expect(diagnostics.sections.find((section) => section.id === "server")?.observations[0]).toMatchObject({
      label: "Server check",
      value: "Connected",
    });
  });

  it("keeps transport failures and success timestamps in expanded observations", () => {
    const diagnostics = deriveConnectionDiagnostics({
      ...base,
      status: "closed",
      reconnecting: true,
      retryCount: 2,
      lastWebSocketOpenAt: new Date("2026-08-11T14:07:32Z").getTime(),
      lastServerMessageAt: new Date("2026-08-11T14:09:48Z").getTime(),
      lastTransportDiagnostic: {
        kind: "replay_http",
        text: "Replay request rejected: HTTP 403 Forbidden.",
        at: new Date("2026-08-11T14:09:49Z").getTime(),
      },
      reconnectingSince: new Date("2026-08-11T14:09:50Z").getTime(),
    });
    const observations = diagnostics.sections.flatMap((section) => section.observations);
    expect(observations).toContainEqual({
      label: "Last connection event",
      state: "failed",
      value: expect.stringContaining("Replay request rejected: HTTP 403 Forbidden."),
    });
    expect(observations.map((observation) => observation.label)).toEqual(
      expect.arrayContaining(["Conversation stream", "Conversation updates"]),
    );
  });
});
