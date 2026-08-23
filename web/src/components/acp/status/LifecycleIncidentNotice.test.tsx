// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LifecycleIncidentNotice } from "./LifecycleIncidentNotice";

afterEach(cleanup);

describe("LifecycleIncidentNotice", () => {
  it("renders the shared working, action, and failure states", () => {
    const onInvoke = vi.fn();
    const result = render(
      <LifecycleIncidentNotice
        title="Agent unavailable"
        detail="No worker is running."
        tone="warning"
        working
        primaryAction={{
          label: "Start agent",
          pendingLabel: "Starting…",
          phase: "idle",
          onInvoke,
        }}
      />,
    );
    fireEvent.click(result.getByRole("button", { name: "Start agent" }));
    expect(onInvoke).toHaveBeenCalledTimes(1);
    expect(result.container.querySelector(".animate-spin")).not.toBeNull();

    result.rerender(
      <LifecycleIncidentNotice
        title="Agent unavailable"
        detail="No worker is running."
        tone="error"
        primaryAction={{
          label: "Retry start",
          pendingLabel: "Retrying…",
          phase: "failed",
          error: "Start failed: binary missing",
          onInvoke,
        }}
      />,
    );
    expect(result.getByText("Start failed: binary missing")).toBeDefined();
    expect(result.getByRole("alert")).toBeDefined();
  });
});
