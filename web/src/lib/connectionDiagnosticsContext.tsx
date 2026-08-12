/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { ConnectionDiagnostics } from "../components/acp/status/connectionStatus";

export type ConnectionDiagnosticsKind = "structured" | "terminal";

export interface PublishedConnectionDiagnostics {
  sessionId: string;
  kind: ConnectionDiagnosticsKind;
  diagnostics: ConnectionDiagnostics;
  /** A routine connection attempt is already visible in the header, but is
   * not yet disruptive enough to show the transcript overlay. */
  incidentVisible: boolean;
  onReconnect?: () => void;
}

interface ConnectionDiagnosticsContextValue {
  published: PublishedConnectionDiagnostics | null;
  publish: (snapshot: PublishedConnectionDiagnostics) => void;
  clear: (sessionId: string) => void;
}

const ConnectionDiagnosticsContext = createContext<ConnectionDiagnosticsContextValue | null>(null);

/** Shares the active view's existing connection observations with the global
 * header. A session id is carried with every snapshot, so a late unmount from
 * the previous view cannot briefly describe the newly selected session. */
export function ConnectionDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [published, setPublished] = useState<PublishedConnectionDiagnostics | null>(null);
  const publish = useCallback((snapshot: PublishedConnectionDiagnostics) => {
    setPublished((current) => {
      if (
        current?.sessionId === snapshot.sessionId &&
        current.kind === snapshot.kind &&
        current.incidentVisible === snapshot.incidentVisible &&
        JSON.stringify(current.diagnostics) === JSON.stringify(snapshot.diagnostics)
      ) {
        return current;
      }
      return snapshot;
    });
  }, []);
  const clear = useCallback((sessionId: string) => {
    setPublished((current) => (current?.sessionId === sessionId ? null : current));
  }, []);
  const value = useMemo(() => ({ published, publish, clear }), [clear, published, publish]);
  return <ConnectionDiagnosticsContext.Provider value={value}>{children}</ConnectionDiagnosticsContext.Provider>;
}

export function useConnectionDiagnosticsPublisher() {
  const context = useContext(ConnectionDiagnosticsContext);
  return {
    publish: context?.publish ?? (() => undefined),
    clear: context?.clear ?? (() => undefined),
  };
}

export function usePublishedConnectionDiagnostics(activeSessionId: string | null) {
  const context = useContext(ConnectionDiagnosticsContext);
  return context?.published?.sessionId === activeSessionId ? context.published : null;
}
