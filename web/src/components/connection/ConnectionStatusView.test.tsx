// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { deriveConnectionDiagnostics } from "../acp/status/connectionStatus";
import { ConnectionRoute } from "./ConnectionStatusView";

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

describe("ConnectionRoute", () => {
  it("assigns progress animation to the in-flight route edge, not its endpoint", () => {
    const cases = [
      {
        name: "reconnecting route",
        input: { status: "closed" as const, reconnecting: true, retryCount: 2 },
        activeEdge: "connection-edge-device-to-aoe",
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
        <ConnectionRoute diagnostics={deriveConnectionDiagnostics({ ...base, ...input })} />,
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
});
