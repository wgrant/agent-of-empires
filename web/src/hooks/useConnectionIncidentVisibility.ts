import { useEffect, useRef, useState } from "react";

import type { ConnectionDiagnostics } from "../components/acp/status/connectionStatus";

// A new structured view starts by opening its conversation socket. Most
// session switches complete within this interval, so presenting that expected
// handoff as a connection incident creates a distracting flash and relayout.
// A slow start still becomes visible, while every observed failure bypasses
// the delay. Keep this aligned with the design system's medium duration.
export const INITIAL_CONNECTION_INCIDENT_DELAY_MS = 300;

export function shouldDelayInitialConnectionIncident(
  diagnostics: ConnectionDiagnostics,
): boolean {
  return (
    diagnostics.hasIncident &&
    diagnostics.initialConnection &&
    diagnostics.session === "starting" &&
    diagnostics.serverReachability === "unknown"
  );
}

function initialVisibility(diagnostics: ConnectionDiagnostics): boolean {
  return (
    diagnostics.hasIncident &&
    !shouldDelayInitialConnectionIncident(diagnostics)
  );
}

/**
 * Keep expected initial socket setup quiet, without hiding a slow start or a
 * real connection problem. `sessionId` is explicit so a reused view cannot
 * briefly carry an incident from the previously selected session.
 */
export function useConnectionIncidentVisibility(
  sessionId: string,
  diagnostics: ConnectionDiagnostics,
): boolean {
  const initial = initialVisibility(diagnostics);
  const [visibility, setVisibility] = useState(() => ({
    sessionId,
    visible: initial,
  }));
  const currentSessionIdRef = useRef(sessionId);

  if (currentSessionIdRef.current !== sessionId) {
    currentSessionIdRef.current = sessionId;
    setVisibility({ sessionId, visible: initial });
  }

  const delayed = shouldDelayInitialConnectionIncident(diagnostics);
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
    const timer = window.setTimeout(
      () => setVisibility({ sessionId, visible: true }),
      INITIAL_CONNECTION_INCIDENT_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [delayed, diagnostics.hasIncident, sessionId]);

  return visibility.sessionId === sessionId ? visibility.visible : initial;
}
