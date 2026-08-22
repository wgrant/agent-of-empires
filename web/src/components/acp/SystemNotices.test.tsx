// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveStructuredConnectionDiagnostics, SystemNotices } from "./SystemNotices";
import type { ConnectionStatusInput, ConnectionStatusSnapshot } from "./status/connectionStatus";

afterEach(cleanup);

const base: Omit<ConnectionStatusInput, "rateLimitText"> = {
  status: "open",
  serverReachability: "reachable",
  lagged: false,
  rateLimit: null,
  agentRuntime: { kind: "ready" },
  lastWebSocketOpenAt: null,
  lastServerMessageAt: null,
  lastTransportDiagnostic: null,
  reconnectingSince: null,
  liveUpdatesStale: false,
  hasEverOpened: true,
  reconnecting: false,
  retryCount: 0,
  retryCountdown: 0,
  maxRetries: 7,
};

function snapshot(changes: Partial<typeof base> = {}): ConnectionStatusSnapshot & {
  session: NonNullable<ConnectionStatusSnapshot["session"]>;
} {
  const input = { ...base, ...changes };
  const diagnostics = deriveStructuredConnectionDiagnostics(input);
  return {
    dashboard: { phase: "connected", lastSuccessAt: null, failureSince: null },
    session: {
      kind: "structured",
      sessionId: "session-1",
      diagnostics,
      transport: {
        route: diagnostics.route,
        connectedAt: input.lastWebSocketOpenAt,
        lastMessageAt: input.lastServerMessageAt,
        reconnectingSince: input.reconnectingSince,
        retryCount: input.retryCount,
        retryCountdown: input.retryCountdown,
        maxRetries: input.maxRetries,
        lastFailure: input.lastTransportDiagnostic,
      },
    },
  };
}

describe("SystemNotices", () => {
  it("shows initial conversation loading instead of a connection incident", () => {
    const result = render(
      <SystemNotices
        connectionSnapshot={snapshot({ status: "connecting", hasEverOpened: false })}
        conversationSync="initial"
        manualReconnect={vi.fn()}
      />,
    );
    expect(result.getByRole("status").textContent).toContain("Loading conversation…");
    expect(result.queryByTestId("connection-incident-summary")).toBeNull();
  });

  it("renders the selected reconnect snapshot without lifecycle action inputs", () => {
    const result = render(
      <SystemNotices
        connectionSnapshot={snapshot({ status: "closed", reconnecting: true, retryCount: 1 })}
        manualReconnect={vi.fn()}
      />,
    );
    expect(result.getByLabelText("Device to AoE: ready")).toBeDefined();
    expect(result.getByLabelText("AoE to agent: inactive")).toBeDefined();
    expect(result.getByTestId("connection-incident-summary").className).toContain("text-status-warning");
  });

  it("renders only the diagnostics publisher for a healthy session", () => {
    const { container } = render(
      <SystemNotices connectionSnapshot={snapshot()} manualReconnect={vi.fn()} showConnectionIncident={false} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
