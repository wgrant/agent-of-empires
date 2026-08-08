// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Markdown", () => ({
  Markdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { AssistantReasoning } from "./ThreadMessages";

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
