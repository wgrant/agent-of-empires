// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityRow, AsyncTask, BackgroundAgent } from "../../../lib/acpTypes";

const agentsMock = vi.fn<() => BackgroundAgent[]>(() => []);
const tasksMock = vi.fn<() => AsyncTask[]>(() => []);
const activityMock = vi.fn<() => ActivityRow[]>(() => []);
vi.mock("../../../hooks/useAcpSession", () => ({
  useBackgroundAgents: () => agentsMock(),
  useAsyncTasks: () => tasksMock(),
  useSessionActivity: () => activityMock(),
}));

import { BackgroundWorkChip } from "../BackgroundWorkChip";

afterEach(cleanup);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const explorer: BackgroundAgent = {
  agentId: "kid",
  toolCallId: "",
  description: "Explorer",
  prompt: "",
  model: "",
  status: "running",
  startedAt: ago(20),
  endedAt: null,
  toolCount: 0,
  tools: [],
  lastTool: null,
  lastText: null,
  result: null,
  warning: null,
};
const shell: AsyncTask = {
  id: "sh1",
  name: "dev server",
  taskType: "shell",
  description: null,
  toolCallId: null,
  canStop: true,
  state: "running",
  activity: null,
  usage: null,
  summary: null,
  startedAt: ago(30),
  endedAt: null,
};

describe("BackgroundWorkChip", () => {
  it.each([
    ["recent agent activity", ago(1), "2 in background", false],
    ["a silent agent", ago(7), "2 in background · quiet 7m", true],
  ])("with %s", (_name, lastRow, text, quiet) => {
    agentsMock.mockReturnValue([explorer]);
    tasksMock.mockReturnValue([shell]);
    activityMock.mockReturnValue([{ id: "m1", kind: "message", text: "x", at: lastRow, subagentId: "kid" }]);
    const { getByTestId } = render(<BackgroundWorkChip sessionId="s1" />);
    const chip = getByTestId("composer-background-work");
    expect(chip.textContent).toBe(text);
    expect(chip.hasAttribute("data-quiet")).toBe(quiet);
    expect(chip.getAttribute("title")).toContain("dev server · running 30m");
  });

  it("does not warn about work that reports nothing while it runs", () => {
    agentsMock.mockReturnValue([]);
    tasksMock.mockReturnValue([shell]);
    const { getByTestId } = render(<BackgroundWorkChip sessionId="s1" />);
    expect(getByTestId("composer-background-work").textContent).toBe("1 in background");
  });
});
