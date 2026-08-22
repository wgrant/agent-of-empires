/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { SessionConnectionDiagnostics } from "../components/acp/status/connectionStatus";

export interface PublishedSessionConnectionDiagnostics {
  /** Stable identity for this mounted diagnostic source. Cleanup removes only
   * this source, never another surface describing the same session. */
  sourceId: string;
  /** Only the active primary conversation may drive the global status UI.
   * Auxiliary panes remain registered for pane-local diagnostics. */
  role: "primary" | "auxiliary";
  active: boolean;
  session: SessionConnectionDiagnostics;
  /** A routine connection attempt is already visible in the header, but is
   * not yet disruptive enough to show the transcript overlay. */
  incidentVisible: boolean;
  onReconnect?: () => void;
}

interface ConnectionDiagnosticsContextValue {
  published: Map<string, PublishedSessionConnectionDiagnostics>;
  publish: (snapshot: PublishedSessionConnectionDiagnostics) => void;
  clear: (sourceId: string) => void;
}

const ConnectionDiagnosticsContext = createContext<ConnectionDiagnosticsContextValue | null>(null);

/** Holds the optional session half of connection status. The dashboard half
 * has page lifetime and comes directly from connectionState. A session id is
 * carried with every snapshot, so a late unmount cannot describe a newly
 * selected session. */
export function ConnectionDiagnosticsProvider({ children }: { children: ReactNode }) {
  const [published, setPublished] = useState<Map<string, PublishedSessionConnectionDiagnostics>>(() => new Map());
  const publish = useCallback((snapshot: PublishedSessionConnectionDiagnostics) => {
    setPublished((current) => {
      const previous = current.get(snapshot.sourceId);
      if (
        previous?.session.sessionId === snapshot.session.sessionId &&
        previous.session.kind === snapshot.session.kind &&
        previous.role === snapshot.role &&
        previous.active === snapshot.active &&
        previous.incidentVisible === snapshot.incidentVisible &&
        previous.onReconnect === snapshot.onReconnect &&
        JSON.stringify(previous.session) === JSON.stringify(snapshot.session)
      ) {
        return current;
      }
      const next = new Map(current);
      next.delete(snapshot.sourceId);
      next.set(snapshot.sourceId, snapshot);
      return next;
    });
  }, []);
  const clear = useCallback((sourceId: string) => {
    setPublished((current) => {
      if (!current.has(sourceId)) return current;
      const next = new Map(current);
      next.delete(sourceId);
      return next;
    });
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
  if (!activeSessionId || !context) return null;
  const candidates = [...context.published.values()].filter(
    (entry) => entry.active && entry.role === "primary" && entry.session.sessionId === activeSessionId,
  );
  return candidates.at(-1) ?? null;
}
