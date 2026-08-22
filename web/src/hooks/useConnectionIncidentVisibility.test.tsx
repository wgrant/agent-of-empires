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
  agentRuntime: { kind: "ready" } as const,
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
      [
        "startup failure",
        diagnostics({ agentRuntime: { kind: "failed", category: "startup", message: "failed" } }),
        false,
      ],
      ["stopped agent", diagnostics({ agentRuntime: { kind: "stopped", reason: "user_stopped" } }), false],
      ["restarting agent", diagnostics({ agentRuntime: { kind: "restarting", reason: "manual_restart" } }), false],
      [
        "unresponsive agent",
        diagnostics({ agentRuntime: { kind: "restarting", reason: "cancel_unresponsive" } }),
        false,
      ],
      [
        "rate-limited provider",
        diagnostics({
          rateLimit: { kind: "rate_limit", status: "limited", resets_at: null },
          agentRuntime: { kind: "blocked", reason: "rate_limited" },
        }),
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
