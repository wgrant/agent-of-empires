// @vitest-environment jsdom

import { useEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SessionConnectionDiagnostics } from "../components/acp/status/connectionStatus";
import {
  ConnectionDiagnosticsProvider,
  useConnectionDiagnosticsPublisher,
  usePublishedConnectionDiagnostics,
} from "./connectionDiagnosticsContext";

function connection(sessionId: string, kind: "structured" | "terminal"): SessionConnectionDiagnostics {
  return {
    kind,
    sessionId,
    diagnostics: {
      route: "connected",
      continuity: "healthy",
      agent: "ready",
      primary: "connected",
      hasIncident: false,
      retryCount: 0,
      maxRetries: 7,
      detail: "Connected",
      retryDetail: null,
      agentDetail: "Ready",
    },
    transport: {
      route: "connected",
      connectedAt: null,
      lastMessageAt: null,
      reconnectingSince: null,
      retryCount: 0,
      retryCountdown: 0,
      maxRetries: 7,
      lastFailure: null,
    },
  };
}

function Publisher({
  sourceId,
  sessionId,
  kind,
  role,
  active,
}: {
  sourceId: string;
  sessionId: string;
  kind: "structured" | "terminal";
  role: "primary" | "auxiliary";
  active: boolean;
}) {
  const { publish, clear } = useConnectionDiagnosticsPublisher();
  useEffect(() => {
    publish({
      sourceId,
      role,
      active,
      session: connection(sessionId, kind),
      incidentVisible: false,
    });
    return () => clear(sourceId);
  }, [active, clear, kind, publish, role, sessionId, sourceId]);
  return null;
}

function Selected({ sessionId }: { sessionId: string }) {
  const selected = usePublishedConnectionDiagnostics(sessionId);
  return <output data-testid="selected">{selected ? `${selected.sourceId}:${selected.session.kind}` : "none"}</output>;
}

describe("connection diagnostics publication", () => {
  it("selects only the active primary source and cleans up by source identity", async () => {
    const { rerender } = render(
      <ConnectionDiagnosticsProvider>
        <Publisher sourceId="structured:s1" sessionId="s1" kind="structured" role="primary" active />
        <Publisher sourceId="paired:s1" sessionId="s1" kind="terminal" role="auxiliary" active />
        <Publisher sourceId="terminal:s2" sessionId="s2" kind="terminal" role="primary" active={false} />
        <Selected sessionId="s1" />
      </ConnectionDiagnosticsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("structured:s1:structured"));

    rerender(
      <ConnectionDiagnosticsProvider>
        <Publisher sourceId="paired:s1" sessionId="s1" kind="terminal" role="auxiliary" active />
        <Publisher sourceId="terminal:s1" sessionId="s1" kind="terminal" role="primary" active />
        <Publisher sourceId="terminal:s2" sessionId="s2" kind="terminal" role="primary" active={false} />
        <Selected sessionId="s1" />
      </ConnectionDiagnosticsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("selected").textContent).toBe("terminal:s1:terminal"));
  });
});
