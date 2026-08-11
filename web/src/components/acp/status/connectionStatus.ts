import type { AcpState } from "../../../lib/acpTypes";
import type { ConnectionStatus } from "../../../hooks/useAcpSession";

/** State of one user-visible connection hop. The first migration retains the
 * existing notices; later presentation work renders these as the compact
 * This device → AoE → Agent route. */
export type ConnectionHopState = "ready" | "working" | "blocked" | "failed" | "unknown";

export interface ConnectionNotice {
  kind: "info" | "warn";
  text: string;
}

export interface ConnectionIncident {
  device: ConnectionHopState;
  server: ConnectionHopState;
  agent: ConnectionHopState;
  notices: ConnectionNotice[];
  retriesExhausted: boolean;
}

export interface ConnectionStatusInput {
  status: ConnectionStatus;
  lagged: boolean;
  rateLimit: AcpState["rateLimit"];
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
export function deriveConnectionIncident(input: ConnectionStatusInput): ConnectionIncident | null {
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
  const agent =
    input.startupError || input.workerStopped
      ? "failed"
      : input.rateLimit
        ? "blocked"
        : input.workerRestarting || input.agentUnresponsive || input.agentOrphaned
          ? "working"
          : "unknown";
  if (notices.length === 0 && !retriesExhausted && agent === "unknown") return null;

  return {
    device:
      input.status === "open" ? "ready" : input.reconnecting || input.status === "connecting" ? "working" : "failed",
    server: "unknown",
    agent,
    notices,
    retriesExhausted,
  };
}
