import { useEffect, useState } from "react";

import type { ConnectionDiagnostics } from "../components/acp/status/connectionStatus";

// Opening or re-opening a conversation socket is routine. Give it a short
// grace period before it becomes an interruption worth covering the
// transcript for, while still surfacing a sustained failure. This is long
// enough to absorb ordinary session switches and brief mobile flaps.
export const CONNECTION_INCIDENT_DELAY_MS = 3_000;

/** The floating capsule owns route and transcript-continuity interruptions.
 * Agent/provider lifecycle remains available in the header and detail popout,
 * while the session lifecycle surface owns its actionable incident. */
export function hasConnectionIncident(diagnostics: ConnectionDiagnostics): boolean {
  return diagnostics.route !== "connected" || diagnostics.continuity !== "current";
}

export function shouldDelayConnectionIncident(diagnostics: ConnectionDiagnostics): boolean {
  return (
    hasConnectionIncident(diagnostics) &&
    diagnostics.serverReachability !== "unreachable" &&
    (diagnostics.route === "connecting" || diagnostics.route === "reconnecting")
  );
}

function initialVisibility(diagnostics: ConnectionDiagnostics): boolean {
  return hasConnectionIncident(diagnostics) && !shouldDelayConnectionIncident(diagnostics);
}

/**
 * Keep brief conversation-socket churn quiet. Agent/provider lifecycle has a
 * separate session incident surface; `sessionId` is explicit so a reused view
 * cannot briefly carry a route incident from the previously selected session.
 */
export function useConnectionIncidentVisibility(sessionId: string, diagnostics: ConnectionDiagnostics): boolean {
  const initial = initialVisibility(diagnostics);
  const delayed = shouldDelayConnectionIncident(diagnostics);
  const delayKey = `${sessionId}:${diagnostics.route}:${diagnostics.continuity}`;
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

  if (!hasConnectionIncident(diagnostics) || !delayed) return initial;
  return delay.key === delayKey && delay.elapsed;
}
