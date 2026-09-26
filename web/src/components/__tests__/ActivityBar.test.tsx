// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ActivityBar } from "../ActivityBar";
import { BUILTIN_PANES } from "../../lib/panes";

afterEach(() => cleanup());

const descriptorFor = (id: string) => {
  const d = BUILTIN_PANES.find((p) => p.id === id)!;
  return { title: d.title, icon: d.icon };
};

describe("ActivityBar", () => {
  it("renders one toggle per pane and reflects open state", () => {
    const open = new Set(["diff"]);
    const { getByTestId } = render(
      <ActivityBar
        paneIds={["diff", "terminal"]}
        descriptorFor={descriptorFor}
        isOpen={(id) => open.has(id)}
        onToggle={vi.fn()}
      />,
    );
    expect(getByTestId("pane-toggle-diff").getAttribute("aria-pressed")).toBe("true");
    expect(getByTestId("pane-toggle-terminal").getAttribute("aria-pressed")).toBe("false");
  });

  it("counts running work on a pane's toggle", () => {
    const { getByTestId, queryByTestId } = render(
      <ActivityBar
        paneIds={["agents", "diff"]}
        descriptorFor={descriptorFor}
        isOpen={() => false}
        onToggle={vi.fn()}
        badges={{ agents: 2, diff: 0 }}
      />,
    );
    expect(getByTestId("pane-badge-agents").textContent).toBe("2");
    expect(getByTestId("pane-toggle-agents").getAttribute("aria-label")).toBe("Toggle background pane, 2 running");
    expect(queryByTestId("pane-badge-diff")).toBeNull();
  });

  it("calls onToggle with the pane id on click", () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(
      <ActivityBar
        paneIds={["diff", "terminal"]}
        descriptorFor={descriptorFor}
        isOpen={() => true}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(getByTestId("pane-toggle-terminal"));
    expect(onToggle).toHaveBeenCalledWith("terminal");
  });
});
