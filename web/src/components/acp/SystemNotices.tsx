import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";

import type { AcpState } from "../../lib/acpTypes";
import { SwitchAgentModal } from "./SwitchAgentModal";
import { useConnectionDiagnosticsPublisher } from "../../lib/connectionDiagnosticsContext";
import { ConnectionIncidentBubble } from "../connection/ConnectionStatusView";
import {
  deriveConnectionDiagnostics,
  selectConnectionDiagnostics,
  type ConnectionStatusSnapshot,
  type ConnectionStatusInput,
  type SessionConnectionDiagnostics,
} from "./status/connectionStatus";
import type { ConversationSyncStatus } from "./status/conversationSyncStatus";

/** Owns the rate-limit recovery modal toggle and hands its opener to `children`. */
export function RateLimitRecoverySection({
  sessionId,
  currentAgent,
  onPrefill,
  children,
}: {
  sessionId: string;
  currentAgent: string | null;
  onPrefill: (text: string) => void;
  children: (renderProps: { onSwitchAgent: () => void }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children({ onSwitchAgent: () => setOpen(true) })}
      <SwitchAgentModal
        open={open}
        sessionId={sessionId}
        currentAgent={currentAgent}
        onClose={() => setOpen(false)}
        onPrefill={onPrefill}
        trigger="rate_limit"
      />
    </>
  );
}

/** The agent's rate-limit wording without transport prefixes or the trailing
 *  `{"errorKind":...}` fingerprint the connection-end path appends. */
function rateLimitWording(status: string): string {
  const text = status
    .replace(/[\s:]*\{[\s\S]*\}\s*$/, "")
    .replace(/^(?:ACP connection failed:\s*)?(?:Internal error:?\s*)?/, "")
    .trim();
  return text || "the agent did not report a reset time.";
}

export function rateLimitDetail(limit: NonNullable<AcpState["rateLimit"]>): string {
  const reset = limit.resets_at === null ? null : new Date(limit.resets_at);
  return reset && !Number.isNaN(reset.getTime())
    ? `Rate-limited (${limit.kind}); resets at ${reset.toLocaleTimeString()}.`
    : `Rate-limited (${limit.kind}); ${rateLimitWording(limit.status)}`;
}

export function deriveStructuredConnectionDiagnostics(input: Omit<ConnectionStatusInput, "rateLimitText">) {
  return deriveConnectionDiagnostics({
    ...input,
    rateLimitText: rateLimitDetail,
  });
}

export function SystemNotices({
  connectionSnapshot,
  conversationSync = "idle",
  manualReconnect,
  showConnectionIncident = true,
}: {
  connectionSnapshot: ConnectionStatusSnapshot & { session: SessionConnectionDiagnostics };
  conversationSync?: ConversationSyncStatus;
  manualReconnect: () => void;
  showConnectionIncident?: boolean;
}) {
  const displayDiagnostics = selectConnectionDiagnostics(connectionSnapshot);
  const sessionConnection = connectionSnapshot.session;
  const sessionId = sessionConnection.sessionId;
  const initialSessionLoad = conversationSync === "initial";
  const publication = (
    <PublishedConnectionDiagnostics
      sessionId={sessionId}
      sessionConnection={sessionConnection}
      onReconnect={manualReconnect}
      incidentVisible={showConnectionIncident}
    />
  );
  if (initialSessionLoad) {
    return (
      <>
        {publication}
        <InitialConversationLoadNotice />
      </>
    );
  }
  return (
    <>
      {publication}
      {showConnectionIncident && displayDiagnostics.hasIncident && (
        <ConnectionIncidentBubble snapshot={connectionSnapshot} onReconnect={manualReconnect} />
      )}
    </>
  );
}

function PublishedConnectionDiagnostics({
  sessionId,
  sessionConnection,
  onReconnect,
  incidentVisible,
}: {
  sessionId: string;
  sessionConnection: SessionConnectionDiagnostics;
  onReconnect: () => void;
  incidentVisible: boolean;
}) {
  const { publish, clear } = useConnectionDiagnosticsPublisher();
  useEffect(() => {
    publish({ session: sessionConnection, incidentVisible, onReconnect });
    return () => clear(sessionId);
  }, [clear, incidentVisible, onReconnect, publish, sessionConnection, sessionId]);
  return null;
}

function InitialConversationLoadNotice() {
  return <ConversationLoadingBubble />;
}

function ConversationLoadingBubble() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3" role="status">
      <div className="flex items-center gap-2 rounded-full border border-surface-700 bg-surface-850/95 px-3 py-1.5 text-xs text-text-secondary shadow-lg backdrop-blur-sm">
        <RotateCcw className="size-3 animate-spin text-text-muted" aria-hidden="true" />
        Loading conversation…
      </div>
    </div>
  );
}
