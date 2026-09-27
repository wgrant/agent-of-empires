// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityRow, AsyncTask, BackgroundAgent } from "../../../lib/acpTypes";

// The panel reads the live list from the useAcpSession store; mock it so
// the test drives the rendering purely from a fixed agent list.
const agentsMock = vi.fn<() => BackgroundAgent[]>(() => []);
const tasksMock = vi.fn<() => AsyncTask[]>(() => []);
const NO_ROWS: ActivityRow[] = [];
const activityMock = vi.fn<() => ActivityRow[]>(() => NO_ROWS);
vi.mock("../../../hooks/useAcpSession", () => ({
  useBackgroundAgents: () => agentsMock(),
  useAsyncTasks: () => tasksMock(),
  useSessionActivity: () => activityMock(),
}));

import { BackgroundAgentsPanel } from "../BackgroundAgentsPanel";

function agent(over: Partial<BackgroundAgent> = {}): BackgroundAgent {
  return {
    agentId: "a1",
    toolCallId: "task-1",
    description: "Map backend lifecycle",
    prompt: "do the thing",
    model: "claude-opus-4-8",
    status: "running",
    startedAt: new Date(Date.now() - 5000).toISOString(),
    endedAt: null,
    toolCount: 3,
    tools: [],
    lastTool: "Read",
    lastText: "scanning files",
    result: null,
    warning: null,
    ...over,
  };
}

function task(over: Partial<AsyncTask> = {}): AsyncTask {
  return {
    id: "wj242",
    name: "calc-bug-check",
    taskType: "workflow",
    description: "Check calc.py",
    toolCallId: "toolu_1",
    canStop: true,
    state: "running",
    activity: "Review: review:average",
    usage: { total_tokens: 12957, tool_uses: 4, duration_ms: 1779 },
    summary: null,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    endedAt: null,
    ...over,
  };
}

const finished = { status: "completed" as const, endedAt: new Date().toISOString() };

function renderPanel(agents: BackgroundAgent[], tasks: AsyncTask[] = []) {
  agentsMock.mockReturnValue(agents);
  tasksMock.mockReturnValue(tasks);
  return render(<BackgroundAgentsPanel sessionId="s-1" />);
}

describe("BackgroundAgentsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows an empty state with nothing in the background", () => {
    expect(renderPanel([]).container.textContent).toContain("Nothing in the background yet");
  });

  it("lists sub-agents and tasks as one running group with their activity and counts", () => {
    const { container, getAllByTestId } = renderPanel([agent()], [task()]);
    expect(container.textContent).toContain("Running · 2");
    const rows = getAllByTestId("background-item").map((r) => r.textContent ?? "");
    const [agentRow, taskRow] = [
      rows.find((r) => r.includes("Map backend lifecycle"))!,
      rows.find((r) => r.includes("calc-bug-check"))!,
    ];
    for (const text of ["subagent", "scanning files", "3 tools"]) expect(agentRow).toContain(text);
    for (const text of ["workflow", "Review: review:average", "4 tools · 13k tokens"]) expect(taskRow).toContain(text);
    // Internal ids never surface.
    expect(container.textContent).not.toContain("a1");
    expect(container.textContent).not.toContain("wj242");
  });

  it("folds finished work away while something runs, and shows it when nothing does", () => {
    const done = agent({ agentId: "done", toolCallId: "t-done", description: "Done one", ...finished });
    const live = renderPanel([done, agent({ agentId: "run", toolCallId: "t-run", description: "Running one" })]);
    expect(live.container.textContent).toContain("Finished · 1");
    expect(live.container.textContent).not.toContain("Done one");
    fireEvent.click(live.getByRole("button", { name: /Finished/ }));
    expect(live.container.textContent!.indexOf("Running one")).toBeLessThan(
      live.container.textContent!.indexOf("Done one"),
    );
    cleanup();
    expect(renderPanel([done]).container.textContent).toContain("Done one");
  });

  it("expands a finished sub-agent to its task, model, tools, and result", () => {
    const { container, getByRole } = renderPanel([
      agent({
        ...finished,
        result: "found 12 files",
        tools: [
          { name: "Bash", title: "ls -la", ok: true },
          { name: "Read", title: "src/main.rs", ok: false },
        ],
      }),
    ]);
    expect(container.textContent).toContain("done");
    fireEvent.click(getByRole("button", { name: /Map backend lifecycle/ }));
    for (const text of ["do the thing", "claude-opus-4-8", "found 12 files", "tools · 2", "ls -la", "src/main.rs"]) {
      expect(container.textContent).toContain(text);
    }
  });

  it("leaves out the model a native subagent does not report", () => {
    const { container, getByRole } = renderPanel([agent({ ...finished, toolCallId: "", model: "" })]);
    fireEvent.click(getByRole("button", { name: /Map backend lifecycle/ }));
    expect(container.textContent).not.toContain("model");
  });

  it("stops a task on its own, and interrupts the turn for a running sub-agent", () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
    const { getByRole } = renderPanel([agent()], [task()]);
    fireEvent.click(getByRole("button", { name: "Stop task" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-1/acp/async-tasks/wj242/stop", { method: "POST" });
    fireEvent.click(getByRole("button", { name: /Interrupt/ }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-1/acp/cancel", { method: "POST" });
  });

  it.each([
    ["finished", agent(finished)],
    // A stalled agent is no longer writing, so cancel would be a no-op.
    ["stalled", agent({ status: "stalled" })],
  ])("offers no interrupt for a %s sub-agent", (_, a) => {
    expect(renderPanel([a]).queryByRole("button", { name: /Interrupt/ })).toBeNull();
  });

  it("shows an item's transcript card, revealing the transcript first", () => {
    const focused: string[] = [];
    const onFocus = (e: Event) => focused.push((e as CustomEvent<string>).detail);
    window.addEventListener("aoe:focus-transcript-card", onFocus);
    const onShowInTranscript = vi.fn();
    agentsMock.mockReturnValue([agent({ agentId: "kid", toolCallId: "" })]);
    tasksMock.mockReturnValue([task({ taskType: "shell", id: "sh" })]);
    const { getAllByRole } = render(<BackgroundAgentsPanel sessionId="s-1" onShowInTranscript={onShowInTranscript} />);
    // A shell has no card to show.
    const buttons = getAllByRole("button", { name: "Show in transcript" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onShowInTranscript).toHaveBeenCalled();
    expect(focused).toEqual(["native-subagent-kid"]);
    window.removeEventListener("aoe:focus-transcript-card", onFocus);
  });

  it("opens a details modal showing the full task, result, and tools", () => {
    const { getByRole, queryByRole } = renderPanel([
      agent({
        ...finished,
        prompt: "a very long prompt that the narrow panel would clamp",
        result: "the complete final result text",
        tools: [{ name: "Bash", title: "ls -la", ok: true }],
      }),
    ]);
    fireEvent.click(getByRole("button", { name: /open full details/i }));
    const dialog = getByRole("dialog");
    expect(dialog.textContent).toContain("a very long prompt that the narrow panel would clamp");
    expect(dialog.textContent).toContain("the complete final result text");
    expect(dialog.textContent).toContain("ls -la");
    fireEvent.click(getByRole("button", { name: /close/i }));
    expect(queryByRole("dialog")).toBeNull();
  });

  it("says when running work last did anything, and flags a long silence", () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const rows: ActivityRow[] = [{ id: "m1", kind: "message", text: "reading", at: ago(7), subagentId: "kid" }];
    activityMock.mockReturnValue(rows);
    const { getAllByTestId } = renderPanel(
      [agent({ agentId: "kid", toolCallId: "", startedAt: ago(10) })],
      [task({ lastActiveAt: ago(1), startedAt: ago(10) })],
    );
    const labels = getAllByTestId("background-item-last-active");
    const byText = Object.fromEntries(labels.map((l) => [l.textContent, l.className.includes("text-status-warning")]));
    expect(byText).toEqual({ "active 1m ago": false, "active 7m ago": true });
    activityMock.mockReturnValue(NO_ROWS);
  });
});
