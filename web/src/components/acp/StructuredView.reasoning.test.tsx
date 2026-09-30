// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Markdown", () => ({
  Markdown: ({ text, smooth }: { text: string; smooth?: boolean }) => <div data-smooth={String(!!smooth)}>{text}</div>,
}));

import { ThinkingDisplayContext, type ThinkingDisplay } from "../../lib/thinkingDisplay";
import { AssistantReasoning } from "./AssistantReasoning";
import { AssistantText } from "./ThreadMessages";

describe("AssistantReasoning", () => {
  it("keeps a thinking trace collapsed until requested", () => {
    render(<AssistantReasoning text="Inspect the hidden constraint." />);

    const disclosure = screen.getByText("Thinking trace").closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);

    fireEvent.click(screen.getByText("Thinking trace"));
    expect(disclosure?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Inspect the hidden constraint.")).toBeTruthy();
  });

  // Expanded, the trace is inline text with no disclosure to open.
  it.each<[ThinkingDisplay, "none" | "closed" | "inline"]>([
    ["hidden", "none"],
    ["collapsed", "closed"],
    ["expanded", "inline"],
  ])("renders the trace per display %s", (display, shown) => {
    render(
      <ThinkingDisplayContext.Provider value={display}>
        <AssistantReasoning text="Weigh both options." />
      </ThinkingDisplayContext.Provider>,
    );
    const disclosure = screen.queryByText("Thinking trace")?.closest("details") ?? null;
    const inline = screen.queryByTestId("reasoning-inline");
    const got = inline ? "inline" : disclosure && !disclosure.hasAttribute("open") ? "closed" : "none";
    expect(got).toBe(shown);
    if (inline) expect(inline.textContent).toBe("Weigh both options.");
  });
});

describe("AssistantReasoning summaries", () => {
  it("lists title-only summaries without a disclosure", () => {
    render(<AssistantReasoning text={"\n\n**Polling build-all session**\n\n**Running q35 tests**"} />);
    expect(screen.getByTestId("reasoning-summary").textContent).toBe("Polling build-all sessionRunning q35 tests");
    expect(screen.queryByText("Thinking trace")).toBeNull();
  });

  it("labels a summary with prose by its first title", () => {
    render(<AssistantReasoning text={"**Checking the build**\n\nThe log shows a linker error."} />);
    expect(screen.getByText("Checking the build").closest("summary")).toBeTruthy();
  });
});

describe("AssistantText", () => {
  it("smooths a running tail and snaps a completed pre-tool part to full text", () => {
    const { rerender } = render(<AssistantText text="Before the tool." status={{ type: "running" }} />);
    expect(screen.getByText("Before the tool.").dataset.smooth).toBe("true");

    rerender(<AssistantText text="Before the tool." status={{ type: "complete" }} />);
    expect(screen.getByText("Before the tool.").dataset.smooth).toBe("false");
  });
});
