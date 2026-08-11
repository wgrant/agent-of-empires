import { describe, expect, it } from "vitest";

import {
  deriveConnectionIncident,
  deriveDashboardConnectionDiagnostics,
  deriveTerminalConnectionDiagnostics,
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
  lastSuccessfulReplayAt: null,
  lastTransportDiagnostic: null,
};

describe("deriveConnectionIncident", () => {
  it("only creates an incident for a current connection problem", () => {
    expect(deriveConnectionIncident(base)).toBeNull();
    expect(deriveConnectionIncident({ ...base, lagged: true })?.notices).toEqual([
      { kind: "warn", text: "Some events were missed during reconnect." },
    ]);
  });

  it("keeps the existing reconnect and exhausted-retry wording in one model", () => {
    const retrying = deriveConnectionIncident({
      ...base,
      status: "closed",
      reconnecting: true,
      retryCount: 3,
      retryCountdown: 4,
    });
    expect(retrying).toMatchObject({
      device: "ready",
      deviceToServer: "working",
      server: "unknown",
      serverToAgent: "inactive",
      agent: "unknown",
      retriesExhausted: false,
      notices: [{ kind: "warn", text: "Structured view disconnected. Reconnecting (3/7) in 4s…" }],
    });

    const exhausted = deriveConnectionIncident({ ...base, status: "closed", retryCount: 7 });
    expect(exhausted).toMatchObject({
      device: "ready",
      deviceToServer: "failed",
      serverToAgent: "inactive",
      retriesExhausted: true,
      notices: [],
    });
  });

  it("classifies an explicit rate limit as an agent block without inferring server health", () => {
    const incident = deriveConnectionIncident({
      ...base,
      rateLimit: { kind: "provider", status: "later", resets_at: null },
    });
    expect(incident).toMatchObject({ agent: "blocked", server: "unknown" });
    expect(incident?.notices[0]?.text).toContain("Rate-limited");
  });

  it("classifies lifecycle failures without requiring a separate status model", () => {
    expect(deriveConnectionIncident({ ...base, workerRestarting: true })?.agent).toBe("working");
    expect(deriveConnectionIncident({ ...base, startupError: true })?.agent).toBe("failed");
  });

  it("uses authenticated replay evidence for the AoE hop", () => {
    expect(deriveConnectionIncident({ ...base, lagged: true, serverReachability: "reachable" })?.server).toBe("ready");
    expect(deriveConnectionIncident({ ...base, lagged: true, serverReachability: "unreachable" })?.server).toBe(
      "failed",
    );
  });

  it("does not show stale downstream health while reconnecting", () => {
    const incident = deriveConnectionIncident({
      ...base,
      status: "closed",
      reconnecting: true,
      retryCount: 1,
      serverReachability: "reachable",
      workerRestarting: true,
    });
    expect(incident).toMatchObject({
      device: "ready",
      deviceToServer: "working",
      server: "unknown",
      serverToAgent: "inactive",
      agent: "unknown",
    });
  });

  it("keeps dashboard and terminal diagnostics in the same route contract", () => {
    expect(deriveDashboardConnectionDiagnostics(false)).toMatchObject({
      targetLabel: null,
      hasIncident: false,
      deviceToServer: "ready",
      serverToAgent: "inactive",
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
      hasIncident: true,
      severity: "working",
      deviceToServer: "working",
      serverToAgent: "inactive",
    });
  });

  it("keeps transport failures and success timestamps in expanded observations", () => {
    const diagnostics = deriveConnectionIncident({
      ...base,
      status: "closed",
      reconnecting: true,
      retryCount: 2,
      lastWebSocketOpenAt: new Date("2026-08-11T14:07:32Z").getTime(),
      lastSuccessfulReplayAt: new Date("2026-08-11T14:09:47Z").getTime(),
      lastServerMessageAt: new Date("2026-08-11T14:09:48Z").getTime(),
      lastTransportDiagnostic: {
        kind: "replay_http",
        text: "Replay request rejected: HTTP 403 Forbidden.",
        at: new Date("2026-08-11T14:09:49Z").getTime(),
      },
    });
    const observations = diagnostics?.sections.flatMap((section) => section.observations) ?? [];
    expect(observations).toContainEqual({
      label: "Last transport result",
      state: "failed",
      value: "Replay request rejected: HTTP 403 Forbidden.",
    });
    expect(observations.map((observation) => observation.label)).toEqual(
      expect.arrayContaining(["Last connected", "Last successful replay", "Last server message"]),
    );
  });
});
