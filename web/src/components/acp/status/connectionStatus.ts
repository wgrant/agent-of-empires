import type { AcpState } from "../../../lib/acpTypes";
import type { ConnectionStatus, TransportDiagnostic } from "../../../hooks/useAcpSession";

export type ConnectionHopState = "ready" | "working" | "blocked" | "failed" | "unknown";
export type ConnectionEdgeState = "ready" | "working" | "blocked" | "failed" | "inactive";

/** What the browser can currently establish about its route to AoE. */
export type ConnectionRouteStatus = "connected" | "connecting" | "reconnecting" | "disconnected";

/** The last observed ACP-session availability. This is gated by route status
 * before it is presented as current state. */
export type AgentSessionStatus =
  | "ready"
  | "starting"
  | "restarting"
  | "stopped"
  | "failed"
  | "unresponsive"
  | "rate_limited"
  | "unknown";

/** Whether transcript updates can be treated as current. */
export type ConversationContinuity = "current" | "delayed" | "missed" | "unavailable";

/** The sole status used by compact and expanded status entry points. */
export type PrimaryConnectionStatus =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected"
  | "agent_starting"
  | "agent_restarting"
  | "agent_stopped"
  | "agent_failed"
  | "agent_unresponsive"
  | "rate_limited"
  | "updates_delayed"
  | "updates_missed"
  | "updates_unavailable";

export type ConnectionStatusTone = "neutral" | "warning" | "error";

export interface ConnectionStatusPresentation {
  headline: string;
  description: string;
  tone: ConnectionStatusTone;
  working: boolean;
}

export interface ConnectionDiagnosticObservation {
  label: string;
  state: ConnectionHopState | ConnectionEdgeState;
  value: string;
}

export interface ConnectionDiagnosticSection {
  id: "device" | "conversation" | "server" | "agent" | "provider";
  label: string;
  observations: ConnectionDiagnosticObservation[];
}

export interface ConnectionDiagnostics {
  device: ConnectionHopState;
  deviceToServer: ConnectionEdgeState;
  server: ConnectionHopState;
  serverToAgent: ConnectionEdgeState;
  agent: ConnectionHopState;
  targetLabel: "Agent" | "Terminal" | null;
  route: ConnectionRouteStatus;
  /** Raw reachability observation, retained even while the route is being
   * established so presentation can distinguish an unknown first dial from a
   * known unavailable server. */
  serverReachability: ConnectionStatusInput["serverReachability"];
  session: AgentSessionStatus;
  continuity: ConversationContinuity;
  primary: PrimaryConnectionStatus;
  retriesExhausted: boolean;
  retryCount: number | null;
  maxRetries: number | null;
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
  lastTransportDiagnostic: TransportDiagnostic | null;
  reconnectingSince: number | null;
  liveUpdatesStale: boolean;
}

function displayTime(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toLocaleTimeString();
}

export function connectionStatusPresentation(primary: PrimaryConnectionStatus): ConnectionStatusPresentation {
  switch (primary) {
    case "connected":
      return {
        headline: "Connected",
        description: "Connection healthy.",
        tone: "neutral",
        working: false,
      };
    case "connecting":
      return {
        headline: "Connecting",
        description: "Connecting to AoE.",
        tone: "warning",
        working: true,
      };
    case "reconnecting":
      return {
        headline: "Reconnecting",
        description: "Reconnecting to AoE.",
        tone: "warning",
        working: true,
      };
    case "disconnected":
      return {
        headline: "Disconnected",
        description: "Connection to AoE is unavailable.",
        tone: "error",
        working: false,
      };
    case "agent_starting":
      return {
        headline: "Starting agent",
        description: "Agent session is starting.",
        tone: "warning",
        working: true,
      };
    case "agent_restarting":
      return {
        headline: "Restarting agent",
        description: "Agent session is restarting.",
        tone: "warning",
        working: true,
      };
    case "agent_stopped":
      return {
        headline: "Agent stopped",
        description: "Agent worker stopped.",
        tone: "error",
        working: false,
      };
    case "agent_failed":
      return {
        headline: "Agent failed",
        description: "Agent session could not start.",
        tone: "error",
        working: false,
      };
    case "agent_unresponsive":
      return {
        headline: "Agent unresponsive",
        description: "Agent session has not responded.",
        tone: "warning",
        working: false,
      };
    case "rate_limited":
      return {
        headline: "Rate limited",
        description: "The agent provider is rate limiting requests.",
        tone: "warning",
        working: false,
      };
    case "updates_delayed":
      return {
        headline: "Updates delayed",
        description: "Live transcript updates are behind.",
        tone: "warning",
        working: false,
      };
    case "updates_missed":
      return {
        headline: "Updates missed",
        description: "Some transcript updates were missed while reconnecting.",
        tone: "warning",
        working: false,
      };
    case "updates_unavailable":
      return {
        headline: "Updates unavailable",
        description: "Transcript updates are currently unavailable.",
        tone: "error",
        working: false,
      };
  }
}

export function connectionStatusCompactLabel(diagnostics: ConnectionDiagnostics): string {
  const presentation = connectionStatusPresentation(diagnostics.primary);
  return diagnostics.primary === "reconnecting"
    ? `${presentation.headline} · ${diagnostics.retryCount ?? 0}/${diagnostics.maxRetries ?? 0}`
    : presentation.headline;
}

/** Composer-side explanation for a session that cannot accept a prompt yet. */
export function connectionComposerNotice(primary: PrimaryConnectionStatus): string {
  return `${connectionStatusPresentation(primary).headline}. New messages will wait until this session resumes.`;
}

function primaryStatus({
  route,
  session,
  continuity,
}: Pick<ConnectionDiagnostics, "route" | "session" | "continuity">): PrimaryConnectionStatus {
  if (route === "disconnected") return "disconnected";
  if (route === "reconnecting") return "reconnecting";
  if (route === "connecting") return "connecting";
  if (session === "failed") return "agent_failed";
  if (session === "stopped") return "agent_stopped";
  if (session === "unresponsive") return "agent_unresponsive";
  if (session === "rate_limited") return "rate_limited";
  if (session === "starting") return "agent_starting";
  if (session === "restarting") return "agent_restarting";
  if (continuity === "unavailable") return "updates_unavailable";
  if (continuity === "missed") return "updates_missed";
  if (continuity === "delayed") return "updates_delayed";
  return "connected";
}

function sessionDescription(session: AgentSessionStatus): string {
  switch (session) {
    case "failed":
      return "Could not start";
    case "stopped":
      return "Worker stopped";
    case "unresponsive":
      return "Not responding";
    case "rate_limited":
      return "Provider is rate limiting requests";
    case "starting":
      return "Starting";
    case "restarting":
      return "Restarting";
    case "ready":
      return "No issue reported";
    case "unknown":
      return "Not observed";
  }
}

/**
 * Turn raw socket and lifecycle observations into one status model. Route is
 * evaluated first: while the browser cannot reach AoE, every downstream ACP
 * observation is historical rather than a current diagnosis.
 */
export function deriveConnectionDiagnostics(input: ConnectionStatusInput): ConnectionDiagnostics {
  const retriesExhausted =
    input.status !== "open" && input.hasEverOpened && !input.reconnecting && input.retryCount >= input.maxRetries;
  const route: ConnectionRouteStatus =
    input.status === "open"
      ? "connected"
      : input.reconnecting
        ? "reconnecting"
        : input.status === "connecting" || input.status === "error"
          ? "connecting"
          : "disconnected";
  const session: AgentSessionStatus = input.startupError
    ? "failed"
    : input.workerStopped
      ? "stopped"
      : input.rateLimit || input.rateLimitRetriesExhausted
        ? "rate_limited"
        : input.agentUnresponsive
          ? "unresponsive"
          : input.workerRestarting || input.agentOrphaned
            ? "restarting"
            : input.status === "connecting" && !input.hasEverOpened
              ? "starting"
              : "ready";
  const continuity: ConversationContinuity =
    route !== "connected" || input.serverReachability === "unreachable"
      ? "unavailable"
      : input.lagged
        ? "missed"
        : input.liveUpdatesStale
          ? "delayed"
          : "current";
  const primary = primaryStatus({ route, session, continuity });
  const deviceToServer: ConnectionEdgeState =
    input.serverReachability === "unreachable"
      ? "failed"
      : input.serverReachability === "reachable"
        ? "ready"
        : route === "disconnected"
          ? "failed"
          : route === "connected"
            ? "ready"
            : "working";
  const observedAgent: ConnectionHopState =
    session === "failed" || session === "stopped"
      ? "failed"
      : session === "rate_limited"
        ? "blocked"
        : session === "starting" || session === "restarting" || session === "unresponsive"
          ? "working"
          : "ready";
  const serverToAgent: ConnectionEdgeState =
    route === "connected"
      ? observedAgent === "failed"
        ? "failed"
        : observedAgent === "blocked"
          ? "blocked"
          : observedAgent === "working"
            ? "working"
            : "ready"
      : "inactive";
  const observedServer: ConnectionHopState =
    input.serverReachability === "reachable"
      ? "ready"
      : input.serverReachability === "unreachable"
        ? "failed"
        : "unknown";
  const reconnectingAt = displayTime(input.reconnectingSince);
  const lastReceivedAt = displayTime(input.lastServerMessageAt);
  const transportAt = displayTime(input.lastTransportDiagnostic?.at ?? null);
  const socketDescription =
    route === "connected"
      ? `Connected${displayTime(input.lastWebSocketOpenAt) ? ` since ${displayTime(input.lastWebSocketOpenAt)}` : ""}`
      : route === "reconnecting"
        ? `Reconnecting${reconnectingAt ? ` since ${reconnectingAt}` : ""} · attempt ${input.retryCount} of ${input.maxRetries}`
        : route === "connecting"
          ? "Connecting"
          : "Disconnected";
  const liveUpdatesDescription =
    continuity === "current"
      ? "Current"
      : continuity === "delayed"
        ? `Behind${lastReceivedAt ? `, last update ${lastReceivedAt}` : ""}`
        : continuity === "missed"
          ? "Some updates were missed while reconnecting"
          : route === "reconnecting"
            ? "Unavailable while reconnecting"
            : "Unavailable while disconnected";
  const routeIsCurrent = route === "connected";

  return {
    device: "ready",
    deviceToServer,
    server: routeIsCurrent ? observedServer : "unknown",
    serverToAgent,
    agent: routeIsCurrent ? observedAgent : "unknown",
    targetLabel: "Agent",
    route,
    serverReachability: input.serverReachability,
    session,
    continuity,
    primary,
    retriesExhausted,
    retryCount: input.retryCount,
    maxRetries: input.maxRetries,
    hasIncident: primary !== "connected",
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "Active" }],
      },
      {
        id: "conversation",
        label: "Conversation",
        observations: [
          {
            label: "Conversation stream",
            state: deviceToServer,
            value: socketDescription,
          },
          ...(input.lagged
            ? [
                {
                  label: "Transcript recovery",
                  state: "blocked" as const,
                  value: "Some updates were missed while reconnecting.",
                },
              ]
            : []),
          {
            label: "Conversation updates",
            state:
              continuity === "current"
                ? "ready"
                : continuity === "delayed"
                  ? "working"
                  : continuity === "unavailable"
                    ? "unknown"
                    : "blocked",
            value: liveUpdatesDescription,
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
        id: "agent",
        label: "Agent",
        observations: [
          {
            label: "Agent session",
            state: routeIsCurrent ? observedAgent : "inactive",
            value: routeIsCurrent ? sessionDescription(session) : `Last known: ${sessionDescription(session)}`,
          },
        ],
      },
      ...(input.rateLimit
        ? [
            {
              id: "provider" as const,
              label: "Provider",
              observations: [
                {
                  label: "Rate limit",
                  state: "blocked" as const,
                  value: input.rateLimitText(input.rateLimit),
                },
              ],
            },
          ]
        : []),
    ],
  };
}

export function deriveDashboardConnectionDiagnostics(serverDown: boolean): ConnectionDiagnostics {
  const route: ConnectionRouteStatus = serverDown ? "disconnected" : "connected";
  return {
    device: "ready",
    deviceToServer: serverDown ? "failed" : "ready",
    server: serverDown ? "failed" : "ready",
    serverToAgent: "inactive",
    agent: "unknown",
    targetLabel: null,
    route,
    serverReachability: serverDown ? "unreachable" : "reachable",
    session: "unknown",
    continuity: serverDown ? "unavailable" : "current",
    primary: serverDown ? "disconnected" : "connected",
    retriesExhausted: false,
    retryCount: null,
    maxRetries: null,
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
  const route: ConnectionRouteStatus = input.connected
    ? "connected"
    : input.reconnecting
      ? "reconnecting"
      : "disconnected";
  const deviceToServer: ConnectionEdgeState =
    route === "connected" ? "ready" : route === "reconnecting" ? "working" : "failed";
  return {
    device: "ready",
    deviceToServer,
    server: input.connected ? "ready" : "unknown",
    serverToAgent: input.connected ? "ready" : "inactive",
    agent: input.connected ? "ready" : "unknown",
    targetLabel: "Terminal",
    route,
    serverReachability: input.connected ? "reachable" : "unknown",
    session: input.connected ? "ready" : "unknown",
    continuity: input.connected ? "current" : "unavailable",
    primary: route,
    retriesExhausted,
    retryCount: input.retryCount,
    maxRetries: input.maxRetries,
    hasIncident: !input.connected,
    sections: [
      {
        id: "device",
        label: "Device",
        observations: [{ label: "Dashboard", state: "ready", value: "Active" }],
      },
      {
        id: "conversation",
        label: "Terminal connection",
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

/** Compatibility selector for incident-only placements. */
export function deriveConnectionIncident(input: ConnectionStatusInput): ConnectionDiagnostics | null {
  const diagnostics = deriveConnectionDiagnostics(input);
  return diagnostics.hasIncident ? diagnostics : null;
}
