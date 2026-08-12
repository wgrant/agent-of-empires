import { useEffect, useRef, useState } from "react";

import type { ConnectionDiagnostics } from "../components/acp/status/connectionStatus";

// Opening or re-opening a conversation socket is routine. Give it a short
// grace period before it becomes an interruption worth covering the
// transcript for, while still surfacing a sustained failure. This is long
// enough to absorb ordinary session switches and brief mobile flaps.
export const CONNECTION_INCIDENT_DELAY_MS = 3_000;

export function shouldDelayConnectionIncident(diagnostics: ConnectionDiagnostics): boolean {
  return (
    diagnostics.hasIncident &&
    diagnostics.serverReachability !== "unreachable" &&
    (diagnostics.session === "starting" || diagnostics.session === "ready") &&
    (diagnostics.route === "connecting" || diagnostics.route === "reconnecting")
  );
}

function initialVisibility(diagnostics: ConnectionDiagnostics): boolean {
  return diagnostics.hasIncident && !shouldDelayConnectionIncident(diagnostics);
}

/**
 * Keep brief conversation-socket churn quiet, without hiding an observed
 * server or agent problem. `sessionId` is explicit so a reused view cannot
 * briefly carry an incident from the previously selected session.
 */
export function useConnectionIncidentVisibility(sessionId: string, diagnostics: ConnectionDiagnostics): boolean {
  const initial = initialVisibility(diagnostics);
  const [visibility, setVisibility] = useState(() => ({ sessionId, visible: initial }));
  const currentSessionIdRef = useRef(sessionId);

  if (currentSessionIdRef.current !== sessionId) {
    currentSessionIdRef.current = sessionId;
    setVisibility({ sessionId, visible: initial });
  }

  const delayed = shouldDelayConnectionIncident(diagnostics);
  useEffect(() => {
    if (!diagnostics.hasIncident) {
      setVisibility({ sessionId, visible: false });
      return;
    }
    if (!delayed) {
      setVisibility({ sessionId, visible: true });
      return;
    }

    setVisibility({ sessionId, visible: false });
    const timer = window.setTimeout(() => setVisibility({ sessionId, visible: true }), CONNECTION_INCIDENT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [delayed, diagnostics.hasIncident, sessionId]);

  return visibility.sessionId === sessionId ? visibility.visible : initial;
}
