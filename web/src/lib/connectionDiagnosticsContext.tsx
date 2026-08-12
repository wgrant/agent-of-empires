/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { SessionConnectionDiagnostics } from "../components/acp/status/connectionStatus";

export interface PublishedSessionConnectionDiagnostics {
  session: SessionConnectionDiagnostics;
  /** A routine connection attempt is already visible in the header, but is
   * not yet disruptive enough to show the transcript overlay. */
  incidentVisible: boolean;
  onReconnect?: () => void;
}

interface ConnectionDiagnosticsContextValue {
  published: PublishedSessionConnectionDiagnostics | null;
  publish: (snapshot: PublishedSessionConnectionDiagnostics) => void;
  clear: (sessionId: string) => void;
}

const ConnectionDiagnosticsContext = createContext<ConnectionDiagnosticsContextValue | null>(null);

/** Holds the optional session half of connection status. The dashboard half
 * has page lifetime and comes directly from connectionState. A session id is
 * carried with every snapshot, so a late unmount cannot describe a newly
 * selected session. */
export function ConnectionDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [published, setPublished] = useState<PublishedSessionConnectionDiagnostics | null>(null);
  const publish = useCallback((snapshot: PublishedSessionConnectionDiagnostics) => {
    setPublished((current) => {
      if (
        current?.session.sessionId === snapshot.session.sessionId &&
        current.session.kind === snapshot.session.kind &&
        current.incidentVisible === snapshot.incidentVisible &&
        JSON.stringify(current.session) === JSON.stringify(snapshot.session)
      ) {
        return current;
      }
      return snapshot;
    });
  }, []);
  const clear = useCallback((sessionId: string) => {
    setPublished((current) => (current?.session.sessionId === sessionId ? null : current));
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
  return context?.published?.session.sessionId === activeSessionId ? context.published : null;
}
