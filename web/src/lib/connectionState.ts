// Whether the backend is reachable, driven by the `/api/sessions` poller; lets the fetch interceptor suppress toast floods.

import { useSyncExternalStore } from "react";

export type DashboardConnectionPhase = "checking" | "connected" | "unavailable";

/** Browser-to-AoE observations, independent of any selected conversation.
 * This is the always-present half of connection status. Session transports
 * contribute the optional second half elsewhere. */
export interface DashboardConnectionDiagnostics {
  phase: DashboardConnectionPhase;
  lastSuccessAt: number | null;
  failureSince: number | null;
}

let diagnostics: DashboardConnectionDiagnostics = {
  phase: "checking",
  lastSuccessAt: null,
  failureSince: null,
};
const listeners = new Set<() => void>();

function publish(next: DashboardConnectionDiagnostics): void {
  if (
    diagnostics.phase === next.phase &&
    diagnostics.lastSuccessAt === next.lastSuccessAt &&
    diagnostics.failureSince === next.failureSince
  ) {
    return;
  }
  diagnostics = next;
  for (const listener of listeners) listener();
}

/** Record an authenticated dashboard request that reached AoE. */
export function reportDashboardConnectionSuccess(at = Date.now()): void {
  publish({ phase: "connected", lastSuccessAt: at, failureSince: null });
}

/** Record an authenticated dashboard request that could not reach AoE. */
export function reportDashboardConnectionFailure(at = Date.now()): void {
  publish({
    phase: "unavailable",
    lastSuccessAt: diagnostics.lastSuccessAt,
    failureSince: diagnostics.failureSince ?? at,
  });
}

export function setServerDown(down: boolean): void {
  if (down) reportDashboardConnectionFailure();
  else reportDashboardConnectionSuccess();
}

export function isServerDown(): boolean {
  return diagnostics.phase === "unavailable";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): DashboardConnectionDiagnostics {
  return diagnostics;
}

export function getDashboardConnectionDiagnostics(): DashboardConnectionDiagnostics {
  return diagnostics;
}

/** Subscribe to the dashboard half of the combined connection model. */
export function useDashboardConnectionDiagnostics(): DashboardConnectionDiagnostics {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Lets controls that need the API disable themselves without prop drilling. */
export function useServerDown(): boolean {
  return useDashboardConnectionDiagnostics().phase === "unavailable";
}

export const OFFLINE_TITLE = "Disconnected — reconnect to use";
