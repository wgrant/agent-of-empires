// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";

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
  agentRuntime: { kind: "ready" } as const,
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
    operational: {
      kind: "active" as const,
      agent: {
        kind: "online" as const,
        since: null,
        condition: { kind: "normal" as const },
        turn: { kind: "idle" as const },
        canSteer: false,
      },
    },
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
        input: { agentRuntime: { kind: "restarting", reason: "manual_restart" } as const },
        activeEdge: "connection-edge-aoe-to-agent",
        pendingNode: "connection-node-agent",
      },
      {
        name: "stopped agent",
        input: { agentRuntime: { kind: "stopped", reason: "user_stopped" } as const },
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
    expect(button.className).toContain("shrink-0");
    expect(button.className).toContain("xl:min-w-32");
    expect(button.getAttribute("title")).toBeNull();
    expect(button.className).not.toContain("hover:bg-surface-700/60");
    expect(button.querySelector(".hover\\:bg-surface-700\\/60")).not.toBeNull();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    expect(button.querySelector(".hidden.xl\\:inline")?.textContent).toBe("Reconnecting · 1/7");
  });

  it("summarizes an expected dormant agent without presenting a connection incident", () => {
    const diagnostics = deriveConnectionDiagnostics({
      ...base,
      status: "connecting",
      hasEverOpened: false,
      agentRuntime: { kind: "dormant", reason: "idle_auto_stop" },
    });
    const { getByRole } = render(<GlobalConnectionStatusButton snapshot={snapshot(diagnostics)} />);
    const button = getByRole("button", { name: "Show connection status" });

    expect(button.className).toContain("text-status-dormant");
    expect(button.querySelector(".bg-status-dormant")).not.toBeNull();
    expect(button.querySelector(".hidden.xl\\:inline")?.textContent).toBe("Dormant");
    expect(button.querySelector(".animate-spin")).toBeNull();
    expect(diagnostics.hasIncident).toBe(false);
  });

  it("dismisses expanded connection details when pressing outside the control", () => {
    const diagnostics = deriveConnectionDiagnostics(base);
    const { getByRole } = render(<GlobalConnectionStatusButton snapshot={snapshot(diagnostics)} />);
    const button = getByRole("button", { name: "Show connection status" });
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(document.body);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
