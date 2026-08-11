/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { ConnectionDiagnostics } from "../components/acp/status/connectionStatus";

export type ConnectionDiagnosticsKind = "structured" | "terminal";

export interface PublishedConnectionDiagnostics {
  sessionId: string;
  kind: ConnectionDiagnosticsKind;
  diagnostics: ConnectionDiagnostics;
  onReconnect?: () => void;
}

interface ConnectionDiagnosticsContextValue {
  published: PublishedConnectionDiagnostics | null;
  publish: (snapshot: PublishedConnectionDiagnostics | null) => void;
}

const ConnectionDiagnosticsContext = createContext<ConnectionDiagnosticsContextValue | null>(null);

/** Shares the active view's existing connection observations with the global
 * header. A session id is carried with every snapshot, so a late unmount from
 * the previous view cannot briefly describe the newly selected session. */
export function ConnectionDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [published, setPublished] = useState<PublishedConnectionDiagnostics | null>(null);
  const publish = useCallback((snapshot: PublishedConnectionDiagnostics | null) => {
    setPublished((current) => {
      if (snapshot === null) return current === null ? current : null;
      if (
        current?.sessionId === snapshot.sessionId &&
        current.kind === snapshot.kind &&
        current.diagnostics.summary === snapshot.diagnostics.summary &&
        current.diagnostics.severity === snapshot.diagnostics.severity &&
        current.diagnostics.deviceToServer === snapshot.diagnostics.deviceToServer &&
        current.diagnostics.serverToAgent === snapshot.diagnostics.serverToAgent
      ) {
        return current;
      }
      return snapshot;
    });
  }, []);
  const value = useMemo(() => ({ published, publish }), [published, publish]);
  return <ConnectionDiagnosticsContext.Provider value={value}>{children}</ConnectionDiagnosticsContext.Provider>;
}

export function useConnectionDiagnosticsPublisher() {
  const context = useContext(ConnectionDiagnosticsContext);
  return context?.publish ?? (() => undefined);
}

export function usePublishedConnectionDiagnostics(activeSessionId: string | null) {
  const context = useContext(ConnectionDiagnosticsContext);
  return context?.published?.sessionId === activeSessionId ? context.published : null;
}
