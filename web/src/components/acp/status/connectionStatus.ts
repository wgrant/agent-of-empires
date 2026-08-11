import type { AcpState } from "../../../lib/acpTypes";
import type { ConnectionStatus, TransportDiagnostic } from "../../../hooks/useAcpSession";

/** State of one user-visible connection hop. The first migration retains the
 * existing notices; later presentation work renders these as the compact
 * This device → AoE → Agent route. */
export type ConnectionHopState = "ready" | "working" | "blocked" | "failed" | "unknown";
export type ConnectionEdgeState = "ready" | "working" | "blocked" | "failed" | "inactive";
export type ConnectionSeverity = "healthy" | "working" | "warning" | "failed";

export interface ConnectionNotice {
  kind: "info" | "warn";
  text: string;
}

export interface ConnectionIncident {
  device: ConnectionHopState;
  deviceToServer: ConnectionEdgeState;
  server: ConnectionHopState;
  serverToAgent: ConnectionEdgeState;
  agent: ConnectionHopState;
  notices: ConnectionNotice[];
  retriesExhausted: boolean;
}

export interface ConnectionDiagnosticObservation {
  label: string;
  state: ConnectionHopState | ConnectionEdgeState;
  value: string;
}

export interface ConnectionDiagnosticSection {
  id: "device" | "transport" | "server" | "agent" | "provider";
  label: string;
  observations: ConnectionDiagnosticObservation[];
}

/** The complete, always-available presentation model for a structured
 * connection. The compact incident capsule and the expanded diagnostics view
 * deliberately consume the same snapshot. */
export interface ConnectionDiagnostics extends ConnectionIncident {
  targetLabel: "Agent" | "Terminal" | null;
  severity: ConnectionSeverity;
  headerLabel: string;
  capsuleLabel: string;
  summary: string;
  hasIncident: boolean;
  sections: ConnectionDiagnosticSection[];
}

export interface ConnectionStatusInput {
  status: ConnectionStatus;
  serverReachability: "reachable" | "unreachable" | "unknown";
  lagged: boolean;
  rateLimit: AcpState["rateLimit"];
  rateLimitRetriesExhausted: boolean;
  hasEverOpened: boolean;
  reconnecting: boolean;
  retryCount: number;
  retryCountdown: number;
  maxRetries: number;
  rateLimitText: (rateLimit: NonNullable<AcpState["rateLimit"]>) => string;
  startupError: boolean;
  workerStopped: boolean;
  workerRestarting: boolean;
  agentUnresponsive: boolean;
  agentOrphaned: boolean;
  lastWebSocketOpenAt: number | null;
  lastServerMessageAt: number | null;
  lastSuccessfulReplayAt: number | null;
  lastTransportDiagnostic: TransportDiagnostic | null;
  reconnectingSince: number | null;
  liveUpdatesStale: boolean;
}

function displayTime(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toLocaleTimeString();
}

/**
 * Turn raw socket/reducer flags into the single connection-status model.
 *
 * A closed browser WebSocket alone does not prove that the server is down,
 * so the server hop deliberately remains unknown until the reachability
 * observation lands. Keeping that uncertainty in the contract prevents the
 * renderer from inventing an Internet/VPN diagnosis.
 */
export function deriveConnectionDiagnostics(input: ConnectionStatusInput): ConnectionDiagnostics {
  const retriesExhausted =
    input.status !== "open" && input.hasEverOpened && !input.reconnecting && input.retryCount >= input.maxRetries;
  const notices: ConnectionNotice[] = [];
  if (input.reconnecting && input.status !== "open") {
    const countdownPart = input.retryCountdown > 0 ? ` in ${input.retryCountdown}s` : "";
    notices.push({
      kind: "warn",
      text: `Reconnecting, attempt ${input.retryCount} of ${input.maxRetries}${countdownPart}.`,
    });
  } else if (input.status === "connecting") {
    notices.push({
      kind: "info",
      text: input.hasEverOpened ? "Reconnecting…" : "Starting structured view…",
    });
  } else if (input.status === "error") {
    notices.push({
      kind: "warn",
      text: input.hasEverOpened ? "Reconnecting… transcript remains available." : "Starting structured view…",
    });
  } else if (input.status === "closed" && !retriesExhausted) {
    notices.push({
      kind: "warn",
      text: input.hasEverOpened ? "Disconnected. Transcript remains available." : "Waiting for structured view…",
    });
  }
  if (input.lagged) notices.push({ kind: "warn", text: "Some updates were missed while reconnecting." });
  if (input.rateLimit) notices.push({ kind: "warn", text: input.rateLimitText(input.rateLimit) });
  if (input.startupError) notices.push({ kind: "warn", text: "Couldn't start agent." });
  else if (input.workerRestarting || input.agentUnresponsive || input.agentOrphaned) {
    notices.push({ kind: "info", text: "Restarting agent. Transcript remains available." });
  }
  const observedAgent =
    input.startupError || input.workerStopped
      ? "failed"
      : input.rateLimit
        ? "blocked"
        : input.workerRestarting || input.agentUnresponsive || input.agentOrphaned
          ? "working"
          : "unknown";
  const deviceToServer: ConnectionEdgeState =
    input.status === "open"
      ? "ready"
      : input.reconnecting || input.status === "connecting" || input.status === "error"
        ? "working"
        : "failed";
  const serverToAgent: ConnectionEdgeState =
    deviceToServer !== "ready"
      ? "inactive"
      : observedAgent === "working"
        ? "working"
        : observedAgent === "blocked"
          ? "blocked"
          : observedAgent === "failed"
            ? "failed"
            : "ready";
  // An agent without a reported lifecycle problem is the healthy default.
  // The adapter does not provide a separate affirmative heartbeat, but a
  // hollow endpoint reads as disconnected despite a ready AoE-to-agent path.
  // Explicit stopped, restart, rate-limit, orphaned, and unresponsive states
  // above continue to override this optimistic presentation.
  const displayedAgent: ConnectionHopState =
    serverToAgent === "inactive" ? "unknown" : observedAgent === "unknown" ? "ready" : observedAgent;

  const observedServer: ConnectionHopState =
    input.serverReachability === "reachable"
      ? "ready"
      : input.serverReachability === "unreachable"
        ? "failed"
        : "unknown";
  const reconnectingAt = displayTime(input.reconnectingSince);
  const lastReceivedAt = displayTime(input.lastServerMessageAt);
  const replayAt = displayTime(input.lastSuccessfulReplayAt);
  const transportAt = displayTime(input.lastTransportDiagnostic?.at ?? null);
  const socketDescription =
    input.status === "open"
      ? `Connected${displayTime(input.lastWebSocketOpenAt) ? ` since ${displayTime(input.lastWebSocketOpenAt)}` : ""}`
      : input.reconnecting
        ? `Reconnecting${reconnectingAt ? ` since ${reconnectingAt}` : ""} · attempt ${input.retryCount} of ${input.maxRetries}`
        : input.status === "connecting"
          ? "Connecting"
          : "Disconnected";
  const liveUpdatesDescription =
    input.status !== "open"
      ? input.reconnecting
        ? "Unavailable while reconnecting"
        : "Unavailable while disconnected"
      : input.liveUpdatesStale
        ? `Behind${lastReceivedAt ? `, last update ${lastReceivedAt}` : ""}`
        : "Current";
  const replayDescription =
    input.lastTransportDiagnostic?.kind === "replay_http"
      ? `Rejected${transportAt ? ` at ${transportAt}` : ""}`
      : input.lastTransportDiagnostic?.kind === "replay_network"
        ? `Unavailable${transportAt ? ` since ${transportAt}` : ""}`
        : replayAt
          ? `Up to date at ${replayAt}`
          : deviceToServer !== "ready"
            ? "Not observed while the structured view is disconnected"
            : input.serverReachability === "reachable"
              ? "Reachable"
              : input.serverReachability === "unreachable"
                ? "Unreachable"
                : "Not observed";

  const hasIncident =
    notices.length > 0 || retriesExhausted || input.rateLimitRetriesExhausted || observedAgent !== "unknown";
  const severity: ConnectionSeverity =
    retriesExhausted || deviceToServer === "failed" || observedAgent === "failed"
      ? "failed"
      : deviceToServer === "working" || observedAgent === "working"
        ? "working"
        : input.rateLimit || input.lagged || notices.some((notice) => notice.kind === "warn")
          ? "warning"
          : "healthy";
  const summary =
    notices.map((notice) => notice.text).join(" · ") ||
    (retriesExhausted
      ? "Disconnected. Auto-retry stopped."
      : input.rateLimitRetriesExhausted
        ? "Provider auto-resume stopped."
        : "Connected.");
  const headerLabel =
    severity === "healthy"
      ? "Connected"
      : severity === "working"
        ? "Reconnecting"
        : severity === "warning"
          ? "Attention"
          : "Disconnected";
  const capsuleLabel =
    severity === "working" && input.reconnecting
      ? `Reconnecting · ${input.retryCount}/${input.maxRetries}`
      : headerLabel;
  const incident: ConnectionIncident = {
    // The browser rendering this header is necessarily alive. Connection
    // progress belongs on the route edge, not on the device itself.
    device: "ready",
    deviceToServer,
    // Do not present a stale successful replay as current reachability while
    // the transport is down. Downstream state resumes once this edge is live.
    server: deviceToServer === "ready" ? observedServer : "unknown",
    serverToAgent,
    agent: displayedAgent,
    notices,
    retriesExhausted,
  };
  return {
    ...incident,
    targetLabel: "Agent",
    severity,
    headerLabel,
    capsuleLabel,
    summary,
    hasIncident,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "Active" }],
      },
      {
        id: "transport",
        label: "Device to AoE",
        observations: [
          {
            label: "Structured view",
            state: deviceToServer,
            value: socketDescription,
          },
          ...(input.lastTransportDiagnostic
            ? [
                {
                  label: "Last connection event",
                  state:
                    input.lastTransportDiagnostic.kind === "replay_http" ? ("failed" as const) : ("working" as const),
                  value: `${transportAt ? `${transportAt} · ` : ""}${input.lastTransportDiagnostic.text}`,
                },
              ]
            : []),
        ],
      },
      {
        id: "server",
        label: "AoE",
        observations: [
          {
            label: "Transcript sync",
            state:
              input.lastTransportDiagnostic?.kind === "replay_http"
                ? "failed"
                : input.lastTransportDiagnostic?.kind === "replay_network"
                  ? "working"
                  : deviceToServer === "ready"
                    ? observedServer
                    : "unknown",
            value: replayDescription,
          },
          ...(input.lagged
            ? [{ label: "Replay", state: "blocked" as const, value: "Some events were missed during reconnect." }]
            : []),
          {
            label: "Live updates",
            state: input.status === "open" ? (input.liveUpdatesStale ? "working" : "ready") : "unknown",
            value: liveUpdatesDescription,
          },
        ],
      },
      {
        id: "agent",
        label: "Agent",
        observations: [
          {
            label: "Agent session",
            state: serverToAgent === "inactive" ? "inactive" : displayedAgent,
            value:
              serverToAgent === "inactive"
                ? "Waiting for the AoE connection"
                : input.startupError
                  ? "Could not start"
                  : input.workerStopped
                    ? "Worker stopped"
                    : input.workerRestarting || input.agentUnresponsive || input.agentOrphaned
                      ? "Restarting"
                      : "No issue reported",
          },
        ],
      },
      ...(input.rateLimit
        ? [
            {
              id: "provider" as const,
              label: "Provider",
              observations: [
                { label: "Rate limit", state: "blocked" as const, value: input.rateLimitText(input.rateLimit) },
              ],
            },
          ]
        : []),
    ],
  };
}

/** Dashboard health comes from the existing session-polling signal. It has no
 * active agent observation, so the route intentionally stops at AoE. */
export function deriveDashboardConnectionDiagnostics(serverDown: boolean): ConnectionDiagnostics {
  const deviceToServer: ConnectionEdgeState = serverDown ? "failed" : "ready";
  return {
    device: "ready",
    deviceToServer,
    server: serverDown ? "failed" : "ready",
    serverToAgent: "inactive",
    agent: "unknown",
    targetLabel: null,
    notices: serverDown ? [{ kind: "warn", text: "Dashboard server unreachable." }] : [],
    retriesExhausted: false,
    severity: serverDown ? "failed" : "healthy",
    headerLabel: serverDown ? "Disconnected" : "Connected",
    capsuleLabel: serverDown ? "Disconnected" : "Connected",
    summary: serverDown ? "Dashboard unavailable." : "Connected.",
    hasIncident: serverDown,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "Active" }],
      },
      {
        id: "server",
        label: "AoE",
        observations: [
          {
            label: "Server check",
            state: serverDown ? "failed" : "ready",
            value: serverDown ? "Unavailable" : "Current",
          },
        ],
      },
    ],
  };
}

export function deriveTerminalConnectionDiagnostics(input: {
  connected: boolean;
  reconnecting: boolean;
  retryCount: number;
  retryCountdown: number;
  maxRetries: number;
}): ConnectionDiagnostics {
  const retriesExhausted = !input.connected && !input.reconnecting && input.retryCount >= input.maxRetries;
  const deviceToServer: ConnectionEdgeState = input.connected ? "ready" : input.reconnecting ? "working" : "failed";
  const summary = input.connected
    ? "Connected."
    : input.reconnecting
      ? `Reconnecting, attempt ${input.retryCount} of ${input.maxRetries}${input.retryCountdown > 0 ? ` in ${input.retryCountdown}s` : ""}.`
      : retriesExhausted
        ? "Disconnected. Auto-retry stopped."
        : "Disconnected.";
  return {
    device: "ready",
    deviceToServer,
    server: input.connected ? "ready" : "unknown",
    serverToAgent: input.connected ? "ready" : "inactive",
    agent: input.connected ? "ready" : "unknown",
    targetLabel: "Terminal",
    notices: input.connected ? [] : [{ kind: retriesExhausted ? "warn" : "info", text: summary }],
    retriesExhausted,
    severity: input.connected ? "healthy" : retriesExhausted ? "failed" : "working",
    headerLabel: input.connected ? "Connected" : retriesExhausted ? "Disconnected" : "Reconnecting",
    capsuleLabel: input.connected ? "Connected" : retriesExhausted ? "Disconnected" : "Reconnecting",
    summary,
    hasIncident: !input.connected,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "Active" }],
      },
      {
        id: "transport",
        label: "Device to AoE",
        observations: [
          {
            label: "Terminal connection",
            state: deviceToServer,
            value: input.connected
              ? "Connected"
              : input.reconnecting
                ? `Reconnecting (${input.retryCount}/${input.maxRetries})${input.retryCountdown > 0 ? ` in ${input.retryCountdown}s` : ""}`
                : "Disconnected",
          },
        ],
      },
      {
        id: "server",
        label: "AoE",
        observations: [
          {
            label: "Terminal relay",
            state: input.connected ? "ready" : "unknown",
            value: input.connected ? "Current" : "Not observed",
          },
        ],
      },
      {
        id: "agent",
        label: "Terminal",
        observations: [
          {
            label: "Terminal",
            state: input.connected ? "ready" : "inactive",
            value: input.connected ? "Connected" : "Waiting for connection",
          },
        ],
      },
    ],
  };
}

/** Compatibility selector for the incident-only placements. */
export function deriveConnectionIncident(input: ConnectionStatusInput): ConnectionDiagnostics | null {
  const diagnostics = deriveConnectionDiagnostics(input);
  return diagnostics.hasIncident ? diagnostics : null;
}
