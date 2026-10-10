// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { CompactionBudgetControl } from "./CompactionBudgetControl";

afterEach(cleanup);

function Form({
  initial = null,
  disabled = false,
  idle = false,
  initialIdle = null,
}: {
  initial?: string | null;
  disabled?: boolean;
  idle?: boolean;
  initialIdle?: string | null;
}) {
  const [value, setValue] = useState(initial);
  const [idleValue, setIdleValue] = useState<string | null>(initialIdle);
  return (
    <CompactionBudgetControl
      state={{
        tokens: null,
        bounds: [100000, 1000000],
        applied_known: true,
        applied_tokens: null,
        idle_supported: idle,
      }}
      value={value}
      disabled={disabled}
      onChange={setValue}
      idleValue={idleValue}
      onIdleChange={setIdleValue}
    />
  );
}

it("keeps the default quiet and edits a custom budget without its own save buttons", () => {
  render(<Form />);
  expect(screen.queryByTestId("compaction-scale")).toBeNull();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
  fireEvent.click(screen.getByTestId("auto-compaction"));
  expect((screen.getByLabelText("Working context budget (tokens)") as HTMLInputElement).value).toBe("100000");
  expect(screen.getByText(/may lose detail/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "200000" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByTestId("auto-compaction"));
  expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
  fireEvent.click(screen.getByTestId("auto-compaction"));
  expect(screen.getByLabelText("Working context budget (tokens)")).toHaveProperty("value", "200000");
});

it("offers opt-in idle compaction only on supported agents and validates its minimum", () => {
  const view = render(<Form />);
  expect(screen.queryByTestId("idle-compaction")).toBeNull();
  view.rerender(<Form idle />);
  expect(screen.queryByLabelText("Idle compaction minimum context (tokens)")).toBeNull();
  expect(screen.queryByText("Cache observations")).toBeNull();
  fireEvent.click(screen.getByTestId("idle-compaction"));
  expect(screen.getByText("Cache observations")).toBeTruthy();
  const input = screen.getByLabelText("Idle compaction minimum context (tokens)");
  expect(input).toHaveProperty("value", "200000");
  fireEvent.change(input, { target: { value: "99999" } });
  expect(screen.getByRole("alert").textContent).toContain("100,000 to 1,000,000");
  fireEvent.change(input, { target: { value: "200000" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.change(input, { target: { value: "350000" } });
  fireEvent.click(screen.getByTestId("idle-compaction"));
  expect(screen.queryByLabelText("Idle compaction minimum context (tokens)")).toBeNull();
  expect(screen.queryByText("Cache observations")).toBeNull();
  fireEvent.click(screen.getByTestId("idle-compaction"));
  expect(screen.getByLabelText("Idle compaction minimum context (tokens)")).toHaveProperty("value", "350000");
});

it("validates empty, fractional and out-of-range budgets and disables editing during save", () => {
  const view = render(<Form initial="200000" />);
  const input = screen.getByLabelText("Working context budget (tokens)");
  for (const value of ["", "50000", "1000001", "100000.5"]) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole("alert").textContent).toContain("100,000 to 1,000,000");
  }
  fireEvent.change(input, { target: { value: "1000000" } });
  expect(screen.queryByRole("alert")).toBeNull();
  view.rerender(<Form disabled />);
  expect(screen.getByTestId("auto-compaction").matches(":disabled")).toBe(true);
  expect(input.matches(":disabled")).toBe(true);
  expect(screen.getByRole("slider").matches(":disabled")).toBe(true);
});

it("edits independent, crossing and coincident thresholds with keyboard and numeric controls", () => {
  render(<Form initial="200000" idle initialIdle="200000" />);
  const auto = screen.getByRole("slider", { name: "Auto-compaction threshold" });
  const idle = screen.getByRole("slider", { name: "Idle compaction minimum" });
  expect(auto.getAttribute("aria-valuenow")).toBe("200000");
  expect(idle.getAttribute("aria-valuenow")).toBe("200000");
  fireEvent.keyDown(idle, { key: "ArrowRight", shiftKey: true });
  expect(screen.getByLabelText("Idle compaction minimum context (tokens)")).toHaveProperty("value", "210000");
  expect(auto.getAttribute("aria-valuenow")).toBe("200000");
  for (const [key, value] of [
    ["ArrowLeft", "199000"],
    ["Home", "100000"],
    ["End", "1000000"],
    ["PageDown", "990000"],
    ["ArrowUp", "991000"],
    ["PageUp", "1000000"],
  ]) {
    fireEvent.keyDown(auto, { key });
    expect(screen.getByLabelText("Working context budget (tokens)")).toHaveProperty("value", value);
  }
  fireEvent.keyDown(auto, { key: "ArrowRight" });
  expect(auto.getAttribute("aria-valuenow")).toBe("1000000");
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "150000" } });
  expect(auto.getAttribute("aria-valuenow")).toBe("150000");
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "" } });
  expect(screen.queryByRole("slider", { name: "Auto-compaction threshold" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("100,000 to 1,000,000");
  expect(idle.getAttribute("aria-valuenow")).toBe("210000");
});

it("does not invent an agent-default threshold when only idle compaction is enabled", () => {
  render(<Form idle initialIdle="300000" />);
  expect(screen.queryByRole("slider", { name: "Auto-compaction threshold" })).toBeNull();
  expect(screen.getByRole("slider", { name: "Idle compaction minimum" }).getAttribute("aria-valuenow")).toBe("300000");
});

it("does not offer an unsupported setting", () => {
  render(
    <CompactionBudgetControl
      state={{ tokens: null, bounds: null, applied_known: false, applied_tokens: null }}
      value={null}
      disabled={false}
      onChange={() => {}}
    />,
  );
  expect(screen.queryByLabelText("Auto-compaction")).toBeNull();
});

it("separates edited policy from the running policy and explains crossing thresholds", () => {
  const state = {
    tokens: 200000,
    bounds: [100000, 1000000] as [number, number],
    applied_known: true,
    applied_tokens: 300000,
    idle_supported: true,
    idle_applied_known: false,
  };
  const props = {
    state,
    value: "200000",
    idleValue: "250000",
    disabled: false,
    onChange: () => {},
    onIdleChange: () => {},
    policyStatus: "Unsaved changes",
  };
  const view = render(<CompactionBudgetControl {...props} running />);
  expect(screen.getByText("Automatic threshold: 300k tokens")).toBeTruthy();
  expect(screen.getByText("Idle compaction: Unknown")).toBeTruthy();
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  expect(screen.getByText(/automatic compaction will usually happen first/)).toBeTruthy();
  view.rerender(<CompactionBudgetControl {...props} running={false} />);
  expect(screen.queryByLabelText("Running compaction settings")).toBeNull();
  view.rerender(
    <CompactionBudgetControl
      {...props}
      state={{ ...state, applied_tokens: 200000, idle_applied_known: true, idle_applied_tokens: 250000 }}
      running
    />,
  );
  expect(screen.queryByLabelText("Running compaction settings")).toBeNull();
});

it("shows observed cache timing without presenting it as a guaranteed cache hit", () => {
  render(
    <CompactionBudgetControl
      state={{
        tokens: null,
        bounds: [100000, 1000000],
        applied_known: true,
        applied_tokens: null,
        idle_supported: true,
        prompt_cache: { refreshedAt: 1000, expiresAt: 3601000, ttlMs: 3600000, contextTokens: 210000 },
      }}
      value={null}
      idleValue="200000"
      onIdleChange={() => {}}
      disabled={false}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText("Estimated cache expiry has passed.")).toBeTruthy();
  expect(screen.getByText("60 min")).toBeTruthy();
  expect(screen.queryByText(/Cache timing unavailable/)).toBeNull();
});
