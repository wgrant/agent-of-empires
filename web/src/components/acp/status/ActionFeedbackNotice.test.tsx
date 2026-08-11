// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActionFeedbackNotice } from "./ActionFeedbackNotice";

describe("ActionFeedbackNotice", () => {
  it("keeps the action outcome and dismissal affordance together", () => {
    const onDismiss = vi.fn();
    const { getByRole, getByText, getByTestId } = render(
      <ActionFeedbackNotice
        title="Model could not switch"
        detail="The adapter rejected this option."
        onDismiss={onDismiss}
        dismissLabel="Dismiss model notice"
        testId="action-feedback"
      />,
    );
    expect(getByTestId("action-feedback")).toBeDefined();
    expect(getByText("The adapter rejected this option.")).toBeDefined();
    fireEvent.click(getByRole("button", { name: "Dismiss model notice" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
