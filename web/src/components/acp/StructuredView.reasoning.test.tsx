// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Markdown", () => ({
  Markdown: ({ text, smooth }: { text: string; smooth?: boolean }) => <div data-smooth={String(!!smooth)}>{text}</div>,
}));

import { AssistantReasoning, AssistantText } from "./ThreadMessages";

describe("AssistantReasoning", () => {
  it("keeps a thinking trace collapsed until requested", () => {
    render(<AssistantReasoning text="Inspect the hidden constraint." />);

    const disclosure = screen.getByText("Thinking trace").closest("details");
    expect(disclosure?.hasAttribute("open")).toBe(false);

    fireEvent.click(screen.getByText("Thinking trace"));
    expect(disclosure?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Inspect the hidden constraint.")).toBeTruthy();
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
