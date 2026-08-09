// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LaunchOptionRestartDialog } from "./LaunchOptionRestartDialog";

afterEach(cleanup);

describe("LaunchOptionRestartDialog", () => {
  it("explains the targeted restart, confirms, and leaves failures actionable", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error("Could not save launch options"));
    render(
      <LaunchOptionRestartDialog
        optionName="Yolo"
        enabled
        warning="OpenCode will run tools without approval."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText(/restart only this session's agent/i)).toBeTruthy();
    expect(screen.getByText(/run tools without approval/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId("launch-option-confirm"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not save"));
    expect(onCancel).not.toHaveBeenCalled();
    expect((screen.getByTestId("launch-option-confirm") as HTMLButtonElement).disabled).toBe(false);
  });
});
