// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { CompactionBudgetControl } from "./CompactionBudgetControl";

afterEach(cleanup);

function Form({ initial = null, disabled = false }: { initial?: string | null; disabled?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <CompactionBudgetControl
      state={{ tokens: null, bounds: [100000, 1000000], applied_known: true, applied_tokens: null }}
      value={value}
      disabled={disabled}
      onChange={setValue}
    />
  );
}

it("keeps the default quiet and edits a custom budget without its own save buttons", () => {
  render(<Form />);
  expect(screen.getByText("Uses the agent’s default compaction policy.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
  fireEvent.change(screen.getByLabelText("Auto-compaction"), { target: { value: "custom" } });
  expect((screen.getByLabelText("Working context budget (tokens)") as HTMLInputElement).value).toBe("100000");
  expect(screen.getByText(/can lose detail/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "200000" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.change(screen.getByLabelText("Auto-compaction"), { target: { value: "default" } });
  expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
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
  expect(screen.getByLabelText("Auto-compaction")).toHaveProperty("disabled", true);
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
