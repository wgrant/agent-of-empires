import { describe, expect, it } from "vitest";

import type { AsyncTask, BackgroundAgent } from "./acpTypes";
import { backgroundItems, runningBackgroundCount } from "./backgroundWork";

const at = (s: number) => `2026-09-26T10:00:${String(s).padStart(2, "0")}Z`;

function agent(over: Partial<BackgroundAgent>): BackgroundAgent {
  return {
    agentId: "a",
    toolCallId: "",
    description: "Explorer",
    prompt: "",
    model: "",
    status: "running",
    startedAt: at(0),
    endedAt: null,
    toolCount: 0,
    tools: [],
    lastTool: null,
    lastText: null,
    result: null,
    warning: null,
    ...over,
  };
}

function task(over: Partial<AsyncTask>): AsyncTask {
  return {
    id: "t",
    name: "calc",
    taskType: "workflow",
    description: null,
    toolCallId: null,
    canStop: true,
    state: "running",
    activity: null,
    usage: null,
    summary: null,
    startedAt: at(0),
    endedAt: null,
    ...over,
  };
}

describe("backgroundItems", () => {
  it("puts running work first, newest first, then finished work by when it ended", () => {
    const items = backgroundItems(
      [
        agent({ agentId: "old-run", startedAt: at(1) }),
        agent({ agentId: "done-late", status: "completed", endedAt: at(40) }),
        agent({ agentId: "stalled", status: "stalled", startedAt: at(5) }),
      ],
      [task({ id: "new-run", startedAt: at(9) }), task({ id: "done-early", state: "failed", endedAt: at(20) })],
    );
    expect(items.map((i) => [i.key, i.state, i.stateLabel])).toEqual([
      ["task-new-run", "running", ""],
      ["agent-stalled", "running", "stalled"],
      ["agent-old-run", "running", ""],
      ["agent-done-late", "done", ""],
      ["task-done-early", "failed", ""],
    ]);
  });

  it("links each item to its transcript card and offers stop only for a running stoppable task", () => {
    const [native, tailed] = backgroundItems(
      [agent({ agentId: "n", startedAt: at(2) }), agent({ agentId: "b", toolCallId: "toolu_1", startedAt: at(1) })],
      [],
    );
    expect([native!.cardId, tailed!.cardId]).toEqual(["native-subagent-n", "subagent-toolu_1"]);
    const [workflow, shell, locked] = backgroundItems(
      [],
      [
        task({ id: "w", startedAt: at(3), usage: { total_tokens: 900, tool_uses: 2, duration_ms: 1 } }),
        task({ id: "s", taskType: "shell", startedAt: at(2) }),
        task({ id: "m", taskType: "monitor", canStop: false, startedAt: at(1) }),
      ],
    );
    expect([workflow!.kind, workflow!.cardId, workflow!.stopTaskId, workflow!.toolCount, workflow!.tokens]).toEqual([
      "workflow",
      "native-subagent-w",
      "w",
      2,
      900,
    ]);
    expect([shell!.kind, shell!.cardId]).toEqual(["shell", null]);
    expect([locked!.kind, locked!.stopTaskId]).toEqual(["monitor", null]);
  });

  it("counts running sub-agents and tasks", () => {
    const agents = [agent({ status: "stalled" }), agent({ status: "completed", endedAt: at(3) })];
    const tasks = [task({ state: "paused" }), task({ state: "stopped", endedAt: at(4) })];
    expect(runningBackgroundCount(agents, tasks)).toBe(2);
  });
});
