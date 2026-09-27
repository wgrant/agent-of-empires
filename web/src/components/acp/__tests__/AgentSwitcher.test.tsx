// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSummary } from "../../../lib/agentView";
import { AgentSwitcher } from "../AgentSwitcher";

afterEach(cleanup);

const agent = (id: string, state: AgentSummary["state"], recent: boolean): AgentSummary => ({
  id,
  name: id,
  kind: null,
  state,
  recent,
});

describe("AgentSwitcher", () => {
  it("folds earlier finished agents into a menu that still opens them", () => {
    const onView = vi.fn();
    render(
      <AgentSwitcher
        agents={[agent("old", "done", false), agent("live", "running", false), agent("new", "done", true)]}
        viewedAgentId={null}
        onView={onView}
      />,
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Lead", "live, working", "new, done"]);
    fireEvent.click(screen.getByTestId("agent-switcher-earlier"));
    fireEvent.click(screen.getByRole("menuitem", { name: /old/ }));
    expect(onView).toHaveBeenCalledWith("old");
  });
});
