// Sub-agents and background tasks as one list for the Background pane: each
// source's states and details normalised to the same row shape.

import { formatDurationSecondsShort } from "../components/sidebar/format";
import { asyncTaskRunning, type AsyncTask, type BackgroundAgent } from "./acpTypes";

export type BackgroundKind = "subagent" | "workflow" | "shell" | "monitor" | "task";
/** `idle`: a teammate between runs, waiting for a message. */
export type BackgroundState = "running" | "idle" | "done" | "failed" | "stopped";

export interface BackgroundItem {
  key: string;
  kind: BackgroundKind;
  name: string;
  state: BackgroundState;
  /** The state as the source names it, when that says more: `stalled`, `paused`, `cancelled`. */
  stateLabel: string;
  /** What it is doing while it runs, else its result. */
  activity: string | null;
  toolCount: number | null;
  tokens: number | null;
  startedAt: string;
  endedAt: string | null;
  /** When it last did anything; `null` for work that reports nothing while it runs. */
  lastActiveAt: string | null;
  /** Set when this item can be stopped on its own. */
  stopTaskId: string | null;
  /** The transcript card holding its detail, when it has one. */
  cardId: string | null;
  /** The agent whose own transcript the view can show. */
  viewAgentId: string | null;
  agent?: BackgroundAgent;
  task?: AsyncTask;
}

const AGENT_STATES: Record<BackgroundAgent["status"], BackgroundState> = {
  running: "running",
  stalled: "running",
  completed: "done",
  error: "failed",
  detached: "stopped",
};

function agentItem(agent: BackgroundAgent, activity: ReadonlyMap<string, string>): BackgroundItem {
  const finished = AGENT_STATES[agent.status];
  const state = finished === "done" && agent.persistent ? "idle" : finished;
  // A native subagent reports no launching tool call; its card is keyed by its session.
  const native = agent.toolCallId === "";
  return {
    key: `agent-${agent.agentId}`,
    kind: "subagent",
    name: agent.description || "Sub-agent",
    state,
    stateLabel: agent.status === "stalled" ? "stalled" : agent.status === "detached" ? "detached" : "",
    activity: state === "running" ? (agent.lastText ?? agent.lastTool) : (agent.result ?? agent.lastText),
    toolCount: agent.toolCount > 0 ? agent.toolCount : null,
    tokens: null,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    lastActiveAt: (native ? activity.get(agent.agentId) : agent.lastActiveAt) ?? agent.startedAt,
    stopTaskId: null,
    cardId: native ? `native-subagent-${agent.agentId}` : agent.toolCallId ? `subagent-${agent.toolCallId}` : null,
    viewAgentId: native ? agent.agentId : null,
    agent,
  };
}

const TASK_KINDS: Record<string, BackgroundKind> = { workflow: "workflow", shell: "shell", monitor: "monitor" };

function taskItem(task: AsyncTask): BackgroundItem {
  const running = asyncTaskRunning(task);
  const state: BackgroundState = running
    ? "running"
    : task.state === "completed"
      ? "done"
      : task.state === "failed"
        ? "failed"
        : "stopped";
  const kind = TASK_KINDS[task.taskType] ?? "task";
  return {
    key: `task-${task.id}`,
    kind,
    name: task.name,
    state,
    stateLabel: task.state === "paused" ? "paused" : "",
    activity: running ? task.activity : (task.summary ?? task.description),
    toolCount: task.usage && task.usage.tool_uses > 0 ? task.usage.tool_uses : null,
    tokens: task.usage && task.usage.total_tokens > 0 ? task.usage.total_tokens : null,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    // A shell or monitor reports nothing until it ends.
    lastActiveAt: kind === "shell" || kind === "monitor" ? null : (task.lastActiveAt ?? task.startedAt),
    stopTaskId: running && task.canStop ? task.id : null,
    // A workflow's run heads its own transcript card.
    cardId: kind === "workflow" ? `native-subagent-${task.id}` : null,
    viewAgentId: kind === "workflow" ? task.id : null,
    task,
  };
}

/** Running items newest first, then finished ones by when they ended. `activity`
 *  holds each native subagent's latest transcript row time. */
export function backgroundItems(
  agents: readonly BackgroundAgent[],
  tasks: readonly AsyncTask[],
  activity: ReadonlyMap<string, string> = new Map(),
): BackgroundItem[] {
  const items = [...agents.map((agent) => agentItem(agent, activity)), ...tasks.map(taskItem)];
  const running = items.filter((i) => i.state === "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const finished = items
    .filter((i) => i.state !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  return [...running, ...finished];
}

export function runningBackgroundCount(agents: readonly BackgroundAgent[], tasks: readonly AsyncTask[]): number {
  return agents.filter((a) => AGENT_STATES[a.status] === "running").length + tasks.filter(asyncTaskRunning).length;
}

/** How long every running item that reports progress may be silent before it looks stuck. */
export const QUIET_AFTER_MS = 5 * 60_000;

/** When the running work that reports progress last did anything, or `null` when none does. */
export function lastBackgroundActivity(items: readonly BackgroundItem[]): number | null {
  const times = items
    .filter((item) => item.state === "running" && item.lastActiveAt)
    .map((item) => Date.parse(item.lastActiveAt!))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

/** `active 40s ago`, or `running 12m` for work that reports nothing while it runs. */
export function backgroundAge(item: BackgroundItem, now: number): string {
  const since = (iso: string) => formatDurationSecondsShort(Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)));
  return item.lastActiveAt ? `active ${since(item.lastActiveAt)} ago` : `running ${since(item.startedAt)}`;
}
