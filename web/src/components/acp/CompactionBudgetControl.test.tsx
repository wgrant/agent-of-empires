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
}: {
  initial?: string | null;
  disabled?: boolean;
  idle?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [idleValue, setIdleValue] = useState<string | null>(null);
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
  expect(screen.getByText("Uses the agent’s default compaction policy.")).toBeTruthy();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
  fireEvent.click(screen.getByTestId("auto-compaction"));
  fireEvent.click(screen.getByTestId("auto-compaction-value-custom"));
  expect((screen.getByLabelText("Working context budget (tokens)") as HTMLInputElement).value).toBe("100000");
  expect(screen.getByText(/May lose detail/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "200000" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByTestId("auto-compaction"));
  fireEvent.click(screen.getByTestId("auto-compaction-value-default"));
  expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
});

it("offers opt-in idle compaction only on supported agents and validates its minimum", () => {
  const view = render(<Form />);
  expect(screen.queryByTestId("idle-compaction")).toBeNull();
  view.rerender(<Form idle />);
  expect(screen.queryByLabelText("Idle compaction minimum context (tokens)")).toBeNull();
  fireEvent.click(screen.getByTestId("idle-compaction"));
  fireEvent.click(screen.getByTestId("idle-compaction-value-on"));
  const input = screen.getByLabelText("Idle compaction minimum context (tokens)");
  expect(input).toHaveProperty("value", "200000");
  fireEvent.change(input, { target: { value: "99999" } });
  expect(screen.getByRole("alert").textContent).toContain("100,000 to 1,000,000");
  fireEvent.change(input, { target: { value: "200000" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByTestId("idle-compaction"));
  fireEvent.click(screen.getByTestId("idle-compaction-value-off"));
  expect(screen.queryByLabelText("Idle compaction minimum context (tokens)")).toBeNull();
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
  expect(input).toHaveProperty("disabled", true);
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
      disabled={false}
      onChange={() => {}}
    />,
  );
  expect(screen.getByText(/Last cache activity/).textContent).toContain("Estimated expiry");
  expect(screen.getByText(/Last cache activity/).textContent).toContain("60 min lifetime");
  expect(screen.queryByText(/Cache timing unavailable/)).toBeNull();
});
