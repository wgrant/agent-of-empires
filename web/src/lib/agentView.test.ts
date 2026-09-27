import { describe, expect, it } from "vitest";

import type { ActivityRow } from "./acpTypes";
import { agentActivity, agentIdOf, listAgents, parseAgentMessages } from "./agentView";

const AT = "2026-09-27T00:00:00Z";
const row = (id: string, kind: ActivityRow["kind"], text: string, extra: Partial<ActivityRow> = {}): ActivityRow => ({
  id,
  kind,
  text,
  at: AT,
  ...extra,
});
const header = (id: string, name: string, state: string | null, parent?: string, persistent = false) =>
  row(`subagent-${id}`, "subagent", `${name}'s task`, {
    subagentId: parent,
    subagent: { id, name, state, persistent },
  });

const rows: ActivityRow[] = [
  row("u1", "user_prompt", "team up"),
  header("r", "reviewer", "completed"),
  header("t", "tester", null),
  header("m", "mate", "completed", undefined, true),
  row("m-r", "message", "bugs found", { subagentId: "r" }),
  row("woken-t", "subagent_woken", '<agent-message from="reviewer">\nadd() subtracts\n</agent-message>', {
    subagentId: "t",
  }),
  row("m-t", "message", "writing tests", { subagentId: "t" }),
  header("n", "nested", null, "t"),
  row("m-n", "message", "nested work", { subagentId: "n" }),
  row("m-lead", "message", "lead text"),
];

describe("agent views", () => {
  it("lists the main agent's direct subagents with their run state", () => {
    expect(listAgents(rows)).toEqual([
      { id: "r", name: "reviewer", kind: null, state: "done" },
      { id: "t", name: "tester", kind: null, state: "running" },
      // A teammate between runs.
      { id: "m", name: "mate", kind: null, state: "idle" },
    ]);
  });

  it("gives an agent its task, its own rows unscoped, and its subagents' rows as they were", () => {
    expect(agentActivity(rows, "t").map((r) => [r.kind, r.text, r.subagentId])).toEqual([
      ["subagent_woken", "tester's task", undefined],
      ["subagent_woken", '<agent-message from="reviewer">\nadd() subtracts\n</agent-message>', undefined],
      ["message", "writing tests", undefined],
      ["subagent", "nested's task", undefined],
      ["message", "nested work", "n"],
    ]);
    expect(agentActivity(rows, "missing")).toEqual([]);
    // An agent with no known task opens straight on its own rows.
    const untasked = rows.map((r) => (r.id === "subagent-r" ? { ...r, text: "" } : r));
    expect(agentActivity(untasked, "r").map((r) => r.text)).toEqual(["bugs found"]);
  });

  it("parses who a teammate message is from, and maps a later run to its agent", () => {
    expect(parseAgentMessages('<agent-message from="reviewer">\nhi\n</agent-message>')).toEqual([
      { from: "reviewer", body: "hi" },
    ]);
    expect(parseAgentMessages("Read calc.py")).toEqual([{ from: null, body: "Read calc.py" }]);
    expect(agentIdOf("t:generation:3")).toBe("t");
    expect(agentIdOf("t")).toBe("t");
  });
});
