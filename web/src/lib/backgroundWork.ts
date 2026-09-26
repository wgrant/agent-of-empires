// Sub-agents and background tasks as one list for the Background pane: each
// source's states and details normalised to the same row shape.

import { asyncTaskRunning, type AsyncTask, type BackgroundAgent } from "./acpTypes";

export type BackgroundKind = "subagent" | "workflow" | "shell" | "monitor" | "task";
export type BackgroundState = "running" | "done" | "failed" | "stopped";

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
  /** Set when this item can be stopped on its own. */
  stopTaskId: string | null;
  /** The transcript card holding its detail, when it has one. */
  cardId: string | null;
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

function agentItem(agent: BackgroundAgent): BackgroundItem {
  const state = AGENT_STATES[agent.status];
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
    stopTaskId: null,
    cardId: native ? `native-subagent-${agent.agentId}` : agent.toolCallId ? `subagent-${agent.toolCallId}` : null,
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
    stopTaskId: running && task.canStop ? task.id : null,
    // A workflow's run heads its own transcript card.
    cardId: kind === "workflow" ? `native-subagent-${task.id}` : null,
    task,
  };
}

/** Running items newest first, then finished ones by when they ended. */
export function backgroundItems(agents: readonly BackgroundAgent[], tasks: readonly AsyncTask[]): BackgroundItem[] {
  const items = [...agents.map(agentItem), ...tasks.map(taskItem)];
  const running = items.filter((i) => i.state === "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const finished = items
    .filter((i) => i.state !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  return [...running, ...finished];
}

export function runningBackgroundCount(agents: readonly BackgroundAgent[], tasks: readonly AsyncTask[]): number {
  return agents.filter((a) => AGENT_STATES[a.status] === "running").length + tasks.filter(asyncTaskRunning).length;
}
