// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { deriveConnectionDiagnostics, type ConnectionDiagnostics } from "../acp/status/connectionStatus";
import { ConnectionRoute, GlobalConnectionStatusButton } from "./ConnectionStatusView";

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

const snapshot = (diagnostics: ConnectionDiagnostics) => ({
  dashboard: { phase: "connected" as const, lastSuccessAt: 100, failureSince: null },
  session: {
    kind: "structured" as const,
    sessionId: "session",
    diagnostics,
    transport: {
      route: diagnostics.route,
      connectedAt: null,
      lastMessageAt: null,
      reconnectingSince: null,
      retryCount: diagnostics.retryCount ?? 0,
      retryCountdown: 0,
      maxRetries: diagnostics.maxRetries ?? 7,
      lastFailure: null,
    },
  },
});

describe("ConnectionRoute", () => {
  it("assigns progress animation to the in-flight route edge, not its endpoint", () => {
    const cases = [
      {
        name: "reconnecting route",
        input: { status: "closed" as const, reconnecting: true, retryCount: 2 },
        // The shared dashboard probe still knows the device can reach AoE;
        // the header spinner carries the per-conversation reconnect progress.
        activeEdge: null,
        pendingNode: null,
      },
      {
        name: "restarting agent",
        input: { workerRestarting: true },
        activeEdge: "connection-edge-aoe-to-agent",
        pendingNode: "connection-node-agent",
      },
      {
        name: "stopped agent",
        input: { workerStopped: true },
        activeEdge: null,
        pendingNode: null,
      },
    ] as const;

    for (const { name, input, activeEdge, pendingNode } of cases) {
      const { getByTestId, unmount } = render(
        <ConnectionRoute snapshot={snapshot(deriveConnectionDiagnostics({ ...base, ...input }))} />,
      );
      const route = getByTestId("connection-route");
      expect(route.querySelectorAll(".animate-spin"), name).toHaveLength(activeEdge ? 1 : 0);

      if (activeEdge) expect(getByTestId(activeEdge).querySelector(".animate-spin"), name).not.toBeNull();
      if (pendingNode) {
        const node = getByTestId(pendingNode);
        expect(node.querySelector(".animate-spin"), name).toBeNull();
        expect(node.querySelector(".bg-status-warning"), name).not.toBeNull();
      }
      unmount();
    }
  });

  it("keeps a routine reconnect neutral in the global header before its incident grace period expires", () => {
    const diagnostics = deriveConnectionDiagnostics({ ...base, status: "closed", reconnecting: true, retryCount: 1 });
    const { getByRole } = render(
      <GlobalConnectionStatusButton snapshot={snapshot(diagnostics)} incidentVisible={false} />,
    );
    const button = getByRole("button", { name: "Show connection status" });
    expect(button.className).toContain("text-text-muted");
    expect(button.className).not.toContain("text-status-warning");
    expect(button.className).toContain("lg:w-40");
    expect(button.className).not.toContain("hover:bg-surface-700/60");
    expect(button.querySelector(".hover\\:bg-surface-700\\/60")).not.toBeNull();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
  });
});
