// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AsyncTask, BackgroundAgent } from "../../../lib/acpTypes";

// The panel reads the live list from the useAcpSession store; mock it so
// the test drives the rendering purely from a fixed agent list.
const agentsMock = vi.fn<() => BackgroundAgent[]>(() => []);
const tasksMock = vi.fn<() => AsyncTask[]>(() => []);
vi.mock("../../../hooks/useAcpSession", () => ({
  useBackgroundAgents: () => agentsMock(),
  useAsyncTasks: () => tasksMock(),
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

describe("BackgroundAgentsPanel", () => {
  it("shows an empty state with no agents", () => {
    agentsMock.mockReturnValue([]);
    const { container } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    expect(container.textContent).toContain("No sub-agents or background tasks yet");
  });

  it("lists background tasks with live activity and stops one on its own", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const task = (over: Partial<AsyncTask>): AsyncTask => ({
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
    });
    tasksMock.mockReturnValue([
      task({ id: "done-shell", name: "npm run dev", taskType: "shell", state: "completed", summary: "exited 0" }),
      task({}),
    ]);
    const { container, getAllByTestId, getByRole } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    expect(container.textContent).toContain("Background tasks · 2");
    const [running, done] = getAllByTestId("async-task-row");
    for (const text of ["calc-bug-check", "workflow", "Review: review:average", "4 tools · 13k tokens"]) {
      expect(running!.textContent).toContain(text);
    }
    expect(done!.textContent).toContain("exited 0");
    fireEvent.click(getByRole("button", { name: "Stop task" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-1/acp/async-tasks/wj242/stop", { method: "POST" });
    tasksMock.mockReturnValue([]);
    vi.unstubAllGlobals();
  });

  it("lists a running agent with description, tool count, and last activity", () => {
    agentsMock.mockReturnValue([agent()]);
    const { container } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    expect(container.textContent).toContain("Sub-agents · 1");
    // Persistent hint: async-only scope + where the sync ones live.
    expect(container.textContent).toContain("native subagent session");
    expect(container.textContent).toContain("The rest run inline in the transcript");
    expect(container.textContent).toContain("Map backend lifecycle");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("3 tools");
    expect(container.textContent).toContain("scanning files");
    // Internal id never surfaces.
    expect(container.textContent).not.toContain("a1");
  });

  it("expands to reveal prompt, model, and result; never leaks the agent id", () => {
    agentsMock.mockReturnValue([
      agent({
        status: "completed",
        endedAt: new Date().toISOString(),
        result: "found 12 files",
      }),
    ]);
    const { container, getAllByRole } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    expect(container.textContent).toContain("done");
    fireEvent.click(getAllByRole("button")[0]!); // row toggle (not the details button)
    expect(container.textContent).toContain("do the thing");
    expect(container.textContent).toContain("claude-opus-4-8");
    expect(container.textContent).toContain("found 12 files");
  });

  it("orders running agents before finished ones", () => {
    agentsMock.mockReturnValue([
      agent({ agentId: "done", toolCallId: "t-done", description: "Done one", status: "completed" }),
      agent({ agentId: "run", toolCallId: "t-run", description: "Running one", status: "running" }),
    ]);
    const { container } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    const runIdx = container.textContent!.indexOf("Running one");
    const doneIdx = container.textContent!.indexOf("Done one");
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeLessThan(doneIdx);
  });

  it("lists the sub-agent's individual tool calls when expanded", () => {
    // Use a finished agent so the only button is the row toggle (no Stop).
    agentsMock.mockReturnValue([
      agent({
        status: "completed",
        endedAt: new Date().toISOString(),
        tools: [
          { name: "Bash", title: "ls -la", ok: true },
          { name: "Read", title: "src/main.rs", ok: false },
          { name: "Grep", title: "tmux", ok: undefined },
        ],
      }),
    ]);
    const { container, getAllByRole } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    // First button is the row toggle; second is the details (modal) button.
    fireEvent.click(getAllByRole("button")[0]!);
    expect(container.textContent).toContain("tools · 3");
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("ls -la");
    expect(container.textContent).toContain("Read");
    expect(container.textContent).toContain("src/main.rs");
    expect(container.textContent).toContain("Grep");
  });

  it("shows a Stop button for active agents that POSTs the session cancel", async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
    agentsMock.mockReturnValue([agent({ status: "running" })]);
    const { getByRole } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    const stop = getByRole("button", { name: /stop/i });
    fireEvent.click(stop);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s-1/acp/cancel", { method: "POST" });
    vi.unstubAllGlobals();
  });

  it("hides the Stop button when no agent is active", () => {
    agentsMock.mockReturnValue([agent({ status: "completed", endedAt: new Date().toISOString() })]);
    const { queryByRole } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    expect(queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("hides the Stop button for a stalled agent (cancel would be a no-op)", () => {
    agentsMock.mockReturnValue([agent({ status: "stalled" })]);
    const { queryByRole } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    expect(queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("opens a details modal showing the full prompt, result, and tools", () => {
    agentsMock.mockReturnValue([
      agent({
        status: "completed",
        endedAt: new Date().toISOString(),
        prompt: "a very long prompt that the narrow panel would clamp",
        result: "the complete final result text",
        tools: [{ name: "Bash", title: "ls -la", ok: true }],
      }),
    ]);
    const { getByRole, getByText } = render(<BackgroundAgentsPanel sessionId="s-1" />);
    fireEvent.click(getByRole("button", { name: /open full details/i }));
    const dialog = getByRole("dialog");
    expect(dialog.textContent).toContain("a very long prompt that the narrow panel would clamp");
    expect(dialog.textContent).toContain("the complete final result text");
    expect(dialog.textContent).toContain("ls -la");
    // Closes on the X button.
    fireEvent.click(getByRole("button", { name: /close/i }));
    expect(() => getByText("the complete final result text")).toThrow();
  });
});
