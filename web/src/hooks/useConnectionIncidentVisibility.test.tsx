// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveConnectionDiagnostics } from "../components/acp/status/connectionStatus";
import {
  INITIAL_CONNECTION_INCIDENT_DELAY_MS,
  shouldDelayInitialConnectionIncident,
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

const diagnostics = (changes = {}) =>
  deriveConnectionDiagnostics({ ...base, ...changes });

describe("useConnectionIncidentVisibility", () => {
  afterEach(() => vi.useRealTimers());

  it("holds only an unknown initial socket handshake, then shows a slow start", () => {
    vi.useFakeTimers();
    const initial = diagnostics({
      status: "connecting",
      hasEverOpened: false,
      serverReachability: "unknown",
    });
    expect(shouldDelayInitialConnectionIncident(initial)).toBe(true);

    const { result, rerender } = renderHook(
      ({ sessionId, value }) =>
        useConnectionIncidentVisibility(sessionId, value),
      { initialProps: { sessionId: "first", value: initial } },
    );
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(INITIAL_CONNECTION_INCIDENT_DELAY_MS));
    expect(result.current).toBe(true);

    rerender({ sessionId: "second", value: diagnostics() });
    expect(result.current).toBe(false);
  });

  it("shows known connection and agent failures immediately", () => {
    const cases = [
      diagnostics({
        status: "connecting",
        hasEverOpened: false,
        serverReachability: "unreachable",
      }),
      diagnostics({
        status: "connecting",
        hasEverOpened: false,
        workerStopped: true,
      }),
      diagnostics({ status: "closed", reconnecting: true, retryCount: 1 }),
    ];
    for (const value of cases) {
      expect(shouldDelayInitialConnectionIncident(value)).toBe(false);
      const { result, unmount } = renderHook(() =>
        useConnectionIncidentVisibility("session", value),
      );
      expect(result.current).toBe(true);
      unmount();
    }
  });
});
