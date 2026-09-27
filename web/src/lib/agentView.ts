// The subagents a session delegated to, and each one's own transcript as a
// thread of its own.

import type { ActivityRow } from "./acpTypes";

/** `idle`: a teammate between runs, waiting for a message. */
export type AgentRunState = "running" | "idle" | "done" | "failed" | "stopped";

export interface AgentSummary {
  id: string;
  name: string;
  /** `workflow` for a Claude workflow run. */
  kind: string | null;
  state: AgentRunState;
}

const TERMINAL: Record<string, AgentRunState> = {
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
  disconnected: "stopped",
};

function runState(state: string | null, persistent: boolean): AgentRunState {
  if (!state) return "running";
  const terminal = TERMINAL[state] ?? "stopped";
  return terminal === "done" && persistent ? "idle" : terminal;
}

/** claude-agent-acp names each later run of a woken teammate `<id>:generation:<n>`. */
export function agentIdOf(sessionId: string): string {
  const i = sessionId.indexOf(":generation:");
  return i < 0 ? sessionId : sessionId.slice(0, i);
}

/** The agents the main agent delegated to directly, in the order they started. */
export function listAgents(rows: readonly ActivityRow[]): AgentSummary[] {
  return rows.flatMap((row) =>
    row.kind === "subagent" && row.subagent && !row.subagentId
      ? [
          {
            id: row.subagent.id,
            name: row.subagent.name,
            kind: row.subagent.kind ?? null,
            state: runState(row.subagent.state ?? null, row.subagent.persistent ?? false),
          },
        ]
      : [],
  );
}

/**
 * One agent's rows as a main-flow transcript: its task opens it as a message,
 * its own rows lose their scope, and the agents it spawned keep theirs so they
 * still render as cards. Everything else in the session drops out.
 */
export function agentActivity(rows: readonly ActivityRow[], agentId: string): ActivityRow[] {
  const header = rows.find((r) => r.kind === "subagent" && r.subagent?.id === agentId);
  if (!header) return [];
  // A spawn row precedes its agent's rows, so one pass collects the subtree.
  const subtree = new Set([agentId]);
  const own = rows.flatMap((row) => {
    if (row === header || !row.subagentId || !subtree.has(row.subagentId)) return [];
    if (row.kind === "subagent" && row.subagent) subtree.add(row.subagent.id);
    return [row.subagentId === agentId ? { ...row, subagentId: undefined } : row];
  });
  const task: ActivityRow = { id: `task-${agentId}`, kind: "subagent_woken", text: header.text, at: header.at };
  return [task, ...own];
}

export interface AgentMessage {
  /** The sending agent, when the message names one. */
  from: string | null;
  body: string;
}

const AGENT_MESSAGE = /<agent-message(?:\s+from="([^"]*)")?[^>]*>\n?([\s\S]*?)\n?<\/agent-message>/g;

/** Claude wraps a teammate's incoming messages in `<agent-message from="…">` tags. */
export function parseAgentMessages(text: string): AgentMessage[] {
  const found = [...text.matchAll(AGENT_MESSAGE)].map((m) => ({ from: m[1] ?? null, body: m[2]!.trim() }));
  return found.length > 0 ? found : [{ from: null, body: text.trim() }];
}
