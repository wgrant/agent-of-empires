// The subagents a session delegated to, and each one's own transcript as a
// thread of its own.

import type { ActivityRow, Approval, ToolCall } from "./acpTypes";

/** `idle`: a teammate between runs, waiting for a message. */
export type AgentRunState = "running" | "idle" | "done" | "failed" | "stopped";

export interface AgentSummary {
  id: string;
  name: string;
  /** `workflow` for a Claude workflow run. */
  kind: string | null;
  state: AgentRunState;
  /** Spawned since the latest user prompt. */
  recent: boolean;
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
  const lastPrompt = rows.findLastIndex((row) => row.kind === "user_prompt" && !row.subagentId);
  return rows.flatMap((row, index) =>
    row.kind === "subagent" && row.subagent && !row.subagentId
      ? [
          {
            id: row.subagent.id,
            name: row.subagent.name,
            kind: row.subagent.kind ?? null,
            state: runState(row.subagent.state ?? null, row.subagent.persistent ?? false),
            recent: index > lastPrompt,
          },
        ]
      : [],
  );
}

/**
 * The running agents the lead's in-flight call is waiting on: those it
 * started, as an Agent call or a forked skill, rather than earlier
 * background work that runs beside it.
 */
export function agentsAwaited(
  rows: readonly ActivityRow[],
  tool: ToolCall | null,
): { name: string; startedAt: string }[] {
  const since = tool ? Date.parse(tool.started_at) : NaN;
  if (Number.isNaN(since)) return [];
  return rows.flatMap((row) =>
    row.kind === "subagent" && row.subagent && !row.subagentId && !row.subagent.state && Date.parse(row.at) >= since
      ? [{ name: row.subagent.name, startedAt: row.at }]
      : [],
  );
}

/**
 * The agents worth a tab: live ones, this turn's, and the one on view. Older
 * finished agents stay reachable from an overflow list instead of piling up.
 */
export function partitionAgents(
  agents: readonly AgentSummary[],
  viewedAgentId: string | null,
): { shown: AgentSummary[]; earlier: AgentSummary[] } {
  const keep = (agent: AgentSummary) =>
    agent.state === "running" || agent.state === "idle" || agent.recent || agent.id === viewedAgentId;
  return { shown: agents.filter(keep), earlier: agents.filter((agent) => !keep(agent)) };
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
  if (!header.text.trim()) return own;
  const task: ActivityRow = { id: `task-${agentId}`, kind: "subagent_woken", text: header.text, at: header.at };
  return [task, ...own];
}

/** When each subagent last recorded anything, counting the agents it spawned. */
export function lastActivityByAgent(rows: readonly ActivityRow[]): Map<string, string> {
  const parents = new Map<string, string | undefined>();
  const latest = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "subagent" && row.subagent) parents.set(row.subagent.id, row.subagentId);
    const seen = new Set<string>();
    for (let id = row.subagentId; id && !seen.has(id); id = parents.get(id)) {
      seen.add(id);
      const previous = latest.get(id);
      if (!previous || Date.parse(row.at) > Date.parse(previous)) latest.set(id, row.at);
    }
  }
  return latest;
}

function spawnRows(rows: readonly ActivityRow[]): Map<string, ActivityRow> {
  return new Map(rows.flatMap((r) => (r.kind === "subagent" && r.subagent ? [[r.subagent.id, r] as const] : [])));
}

/** The top-level agent whose view shows `spawn`'s agent. */
function topLevelSpawn(spawns: ReadonlyMap<string, ActivityRow>, spawn: ActivityRow): ActivityRow {
  let top = spawn;
  for (let depth = 0; top.subagentId && depth < 32; depth += 1) {
    const parent = spawns.get(top.subagentId);
    if (!parent) break;
    top = parent;
  }
  return top;
}

/** The agent whose view shows `agentId`: a nested subagent opens its top-level ancestor's. */
export function resolveViewedAgent(rows: readonly ActivityRow[], agentId: string | null): AgentSummary | undefined {
  if (!agentId) return undefined;
  const spawns = spawnRows(rows);
  const spawn = spawns.get(agentIdOf(agentId));
  const id = spawn ? topLevelSpawn(spawns, spawn).subagent!.id : agentId;
  return listAgents(rows).find((a) => a.id === id);
}

/** Each nested subagent's top-level ancestor, whose card holds it in the main flow. */
export function topLevelAgents(rows: readonly ActivityRow[]): Map<string, string> {
  const spawns = spawnRows(rows);
  return new Map(
    [...spawns].flatMap(([id, spawn]) => (spawn.subagentId ? [[id, topLevelSpawn(spawns, spawn).subagent!.id]] : [])),
  );
}

/** The subagent asking for an approval, and the top-level agent whose view shows it. */
export function approvalAsker(approval: Approval, rows: readonly ActivityRow[]): { id: string; name: string } | null {
  if (!approval.subagent) return null;
  const spawns = spawnRows(rows);
  const asker = spawns.get(agentIdOf(approval.subagent));
  if (!asker?.subagent) return null;
  return { id: topLevelSpawn(spawns, asker).subagent!.id, name: asker.subagent.name };
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
