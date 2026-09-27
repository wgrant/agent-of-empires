import { describe, expect, it } from "vitest";

import type { ActivityRow, Approval } from "./acpTypes";
import {
  agentActivity,
  agentsAwaited,
  agentIdOf,
  approvalAsker,
  lastActivityByAgent,
  listAgents,
  parseAgentMessages,
  partitionAgents,
  resolveViewedAgent,
  topLevelAgents,
} from "./agentView";

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
      { id: "r", name: "reviewer", kind: null, state: "done", recent: true },
      { id: "t", name: "tester", kind: null, state: "running", recent: true },
      // A teammate between runs.
      { id: "m", name: "mate", kind: null, state: "idle", recent: true },
    ]);
  });

  it("waits on the running agents the lead's in-flight call started", () => {
    const at = (t: string) => ({ at: `2026-09-27T00:00:${t}Z` });
    const timeline = [
      { ...header("bg", "background", null), ...at("01") },
      { ...header("fork", "/code-review", null), ...at("05") },
      { ...header("done", "finished", "completed"), ...at("06") },
      { ...header("kid", "nested", null, "fork"), ...at("07") },
    ];
    const tool = { id: "skill", name: "Skill", kind: "other", args_preview: "{}", started_at: "2026-09-27T00:00:04Z" };
    expect(agentsAwaited(timeline, tool)).toEqual([{ name: "/code-review", startedAt: "2026-09-27T00:00:05Z" }]);
    expect(agentsAwaited(timeline, null)).toEqual([]);
  });

  it("keeps tabs for live, this turn's and viewed agents, and folds away the rest", () => {
    const later = [...rows, row("u2", "user_prompt", "next"), header("x", "extra", "failed")];
    const agents = listAgents(later);
    const ids = (list: { id: string }[]) => list.map((a) => a.id);
    // The reviewer finished in an earlier turn; the tester runs, the mate is idle.
    expect(ids(partitionAgents(agents, null).shown)).toEqual(["t", "m", "x"]);
    expect(ids(partitionAgents(agents, null).earlier)).toEqual(["r"]);
    expect(ids(partitionAgents(agents, "r").shown)).toEqual(["r", "t", "m", "x"]);
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

  it("dates each agent's last activity by its own rows and its subagents'", () => {
    const timed = rows.map((r, i) => ({ ...r, at: new Date(Date.UTC(2026, 8, 27, 0, i)).toISOString() }));
    const last = lastActivityByAgent(timed);
    // "t"'s latest is its nested agent's row; "r" last spoke in its own message.
    expect([last.get("t"), last.get("r")]).toEqual([
      timed.find((r) => r.id === "m-n")!.at,
      timed.find((r) => r.id === "m-r")!.at,
    ]);
  });

  it("names who asks for an approval, and the top-level agent whose view shows it", () => {
    const asking = (subagent: string | null) => ({ subagent }) as Approval;
    expect(approvalAsker(asking("t:generation:2"), rows)).toEqual({ id: "t", name: "tester" });
    expect(approvalAsker(asking("n"), rows)).toEqual({ id: "t", name: "nested" });
    expect(approvalAsker(asking(null), rows)).toBeNull();
  });

  it("opens a nested subagent in its top-level ancestor's view", () => {
    expect([null, "t", "t:generation:2", "n", "missing"].map((id) => resolveViewedAgent(rows, id)?.id ?? null)).toEqual(
      [null, "t", "t", "t", null],
    );
    expect(topLevelAgents(rows)).toEqual(new Map([["n", "t"]]));
  });
});
