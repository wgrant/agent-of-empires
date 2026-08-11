import type { AcpState } from "../../../lib/acpTypes";
import type { ConnectionStatus } from "../../../hooks/useAcpSession";

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
      text: `Structured view disconnected. Reconnecting (${input.retryCount}/${input.maxRetries})${countdownPart}…`,
    });
  } else if (input.status === "connecting") {
    notices.push({
      kind: "info",
      text: input.hasEverOpened ? "Reconnecting to structured view…" : "Starting structured view…",
    });
  } else if (input.status === "error") {
    notices.push({
      kind: "warn",
      text: input.hasEverOpened
        ? "Structured view reconnecting… showing cached transcript; new messages disabled."
        : "Starting structured view worker… this can take a few seconds for new sessions.",
    });
  } else if (input.status === "closed" && !retriesExhausted) {
    notices.push({
      kind: "warn",
      text: input.hasEverOpened
        ? "Structured view disconnected. Showing cached transcript; new messages disabled."
        : "Structured view not ready yet. Retrying…",
    });
  }
  if (input.lagged) notices.push({ kind: "warn", text: "Some events were missed during reconnect." });
  if (input.rateLimit) notices.push({ kind: "warn", text: input.rateLimitText(input.rateLimit) });
  if (input.startupError) notices.push({ kind: "warn", text: "Agent could not start." });
  else if (input.workerRestarting || input.agentUnresponsive || input.agentOrphaned) {
    notices.push({ kind: "info", text: "Restarting agent session; transcript preserved." });
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

  const observedServer: ConnectionHopState =
    input.serverReachability === "reachable"
      ? "ready"
      : input.serverReachability === "unreachable"
        ? "failed"
        : "unknown";

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
      ? "Connection lost. Auto-retry stopped."
      : input.rateLimitRetriesExhausted
        ? "Provider auto-resume stopped."
        : "Connection healthy.");
  const incident: ConnectionIncident = {
    // The browser rendering this header is necessarily alive. Connection
    // progress belongs on the route edge, not on the device itself.
    device: "ready",
    deviceToServer,
    // Do not present a stale successful replay as current reachability while
    // the transport is down. Downstream state resumes once this edge is live.
    server: deviceToServer === "ready" ? observedServer : "unknown",
    serverToAgent,
    agent: serverToAgent === "inactive" ? "unknown" : observedAgent,
    notices,
    retriesExhausted,
  };
  return {
    ...incident,
    targetLabel: "Agent",
    severity,
    summary,
    hasIncident,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "This dashboard is running." }],
      },
      {
        id: "transport",
        label: "Device to AoE",
        observations: [
          {
            label: "Structured-view WebSocket",
            state: deviceToServer,
            value:
              input.status === "open"
                ? "Connected"
                : input.reconnecting
                  ? `Reconnecting (${input.retryCount}/${input.maxRetries})${input.retryCountdown > 0 ? ` in ${input.retryCountdown}s` : ""}`
                  : input.status === "connecting"
                    ? "Connecting"
                    : input.status === "error"
                      ? "Connection error"
                      : "Disconnected",
          },
        ],
      },
      {
        id: "server",
        label: "AoE",
        observations: [
          {
            label: "Event replay",
            state: deviceToServer === "ready" ? observedServer : "unknown",
            value:
              deviceToServer !== "ready"
                ? "Not observed while the structured view is disconnected"
                : input.serverReachability === "reachable"
                  ? "Reachable"
                  : input.serverReachability === "unreachable"
                    ? "Unreachable"
                    : "Not observed",
          },
          ...(input.lagged
            ? [{ label: "Replay", state: "blocked" as const, value: "Some events were missed during reconnect." }]
            : []),
        ],
      },
      {
        id: "agent",
        label: "Agent",
        observations: [
          {
            label: "ACP session",
            state: serverToAgent === "inactive" ? "inactive" : observedAgent,
            value:
              serverToAgent === "inactive"
                ? "Inactive until the AoE connection recovers"
                : input.startupError
                  ? "Could not start"
                  : input.workerStopped
                    ? "Worker stopped"
                    : input.workerRestarting || input.agentUnresponsive || input.agentOrphaned
                      ? "Restarting"
                      : "No agent problem observed",
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
    summary: serverDown ? "Dashboard server unreachable." : "Dashboard connected.",
    hasIncident: serverDown,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "This dashboard is running." }],
      },
      {
        id: "server",
        label: "AoE",
        observations: [
          {
            label: "Session polling",
            state: serverDown ? "failed" : "ready",
            value: serverDown ? "Unreachable" : "Reachable",
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
    ? "Terminal connected."
    : input.reconnecting
      ? `Terminal reconnecting (${input.retryCount}/${input.maxRetries})${input.retryCountdown > 0 ? ` in ${input.retryCountdown}s` : ""}.`
      : retriesExhausted
        ? "Terminal connection lost. Auto-retry stopped."
        : "Terminal disconnected.";
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
    summary,
    hasIncident: !input.connected,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "This dashboard is running." }],
      },
      {
        id: "transport",
        label: "Device to AoE",
        observations: [
          {
            label: "Terminal WebSocket",
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
            value: input.connected ? "Reachable" : "Not observed",
          },
        ],
      },
      {
        id: "agent",
        label: "Terminal",
        observations: [
          {
            label: "Terminal stream",
            state: input.connected ? "ready" : "inactive",
            value: input.connected ? "Connected" : "Inactive until the relay reconnects",
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
