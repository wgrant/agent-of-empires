import { useEffect, useState } from "react";

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
  const delayed = shouldDelayConnectionIncident(diagnostics);
  const delayKey = `${sessionId}:${diagnostics.route}:${diagnostics.session}`;
  const [delay, setDelay] = useState(() => ({ key: delayKey, elapsed: false }));
  if (delay.key !== delayKey) {
    setDelay({ key: delayKey, elapsed: false });
  }
  useEffect(() => {
    if (!delayed) return;
    const timer = window.setTimeout(
      () => setDelay((current) => (current.key === delayKey ? { ...current, elapsed: true } : current)),
      CONNECTION_INCIDENT_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [delayKey, delayed]);

  if (!diagnostics.hasIncident || !delayed) return initial;
  return delay.key === delayKey && delay.elapsed;
}
