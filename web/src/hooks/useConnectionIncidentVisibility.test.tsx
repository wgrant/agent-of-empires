// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveConnectionDiagnostics } from "../components/acp/status/connectionStatus";
import {
  CONNECTION_INCIDENT_DELAY_MS,
  hasConnectionIncident,
  shouldDelayConnectionIncident,
  useConnectionIncidentVisibility,
} from "./useConnectionIncidentVisibility";

const base = {
  status: "open" as const,
  serverReachability: "reachable" as const,
  lagged: false,
  rateLimit: null,
  hasEverOpened: true,
  reconnecting: false,
  retryCount: 0,
  retryCountdown: 0,
  maxRetries: 7,
  rateLimitText: () => "Rate limited",
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

const diagnostics = (changes = {}) => deriveConnectionDiagnostics({ ...base, ...changes });

describe("useConnectionIncidentVisibility", () => {
  afterEach(() => vi.useRealTimers());

  it("holds routine socket setup and reconnection, then shows a sustained interruption", () => {
    vi.useFakeTimers();
    const initial = diagnostics({ status: "connecting", hasEverOpened: false, serverReachability: "reachable" });
    expect(shouldDelayConnectionIncident(initial)).toBe(true);

    const { result, rerender } = renderHook(
      ({ sessionId, value }) => useConnectionIncidentVisibility(sessionId, value),
      { initialProps: { sessionId: "first", value: initial } },
    );
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(CONNECTION_INCIDENT_DELAY_MS));
    expect(result.current).toBe(true);

    rerender({ sessionId: "first", value: diagnostics() });
    expect(result.current).toBe(false);

    rerender({ sessionId: "first", value: diagnostics({ status: "closed", reconnecting: true, retryCount: 1 }) });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(CONNECTION_INCIDENT_DELAY_MS));
    expect(result.current).toBe(true);
  });

  it("places only route and continuity failures in the floating incident", () => {
    const cases = [
      ["healthy", diagnostics(), false],
      ["startup failure", diagnostics({ startupError: true }), false],
      ["stopped agent", diagnostics({ workerStopped: true }), false],
      ["restarting agent", diagnostics({ workerRestarting: true }), false],
      ["unresponsive agent", diagnostics({ agentUnresponsive: true }), false],
      [
        "rate-limited provider",
        diagnostics({ rateLimit: { kind: "rate_limit", status: "limited", resets_at: null } }),
        false,
      ],
      ["connecting route", diagnostics({ status: "connecting", hasEverOpened: false }), true],
      ["disconnected route", diagnostics({ status: "closed", retryCount: 7 }), true],
      ["missed updates", diagnostics({ lagged: true }), true],
      ["delayed updates", diagnostics({ liveUpdatesStale: true }), true],
    ] as const;
    for (const [label, value, expected] of cases) {
      expect(hasConnectionIncident(value), label).toBe(expected);
    }
  });

  it("shows known route and continuity failures immediately", () => {
    const cases = [
      diagnostics({ status: "connecting", hasEverOpened: false, serverReachability: "unreachable" }),
      diagnostics({ status: "closed", retryCount: 7 }),
      diagnostics({ lagged: true }),
    ];
    for (const value of cases) {
      expect(shouldDelayConnectionIncident(value)).toBe(false);
      const view = renderHook(() => useConnectionIncidentVisibility("session", value));
      expect(view.result.current).toBe(true);
      view.unmount();
    }
  });
});
