// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Plan, PlanStep } from "../../../lib/acpTypes";
import { PlanStrip } from "../PlanStrip";

afterEach(cleanup);

const plan = (...statuses: PlanStep["status"][]): Plan => ({
  plan_id: "p",
  version: 1,
  steps: statuses.map((status, i) => ({ id: `s${i}`, title: `step ${i}`, status })),
});

describe("PlanStrip", () => {
  it.each<[string, Plan, boolean, boolean]>([
    ["unfinished, idle", plan("Done", "Pending"), false, true],
    ["finished, turn running", plan("Done", "Done"), true, true],
    ["finished, turn over", plan("Done", "Done"), false, false],
    ["finished with a cancelled step, turn over", plan("Done", "Cancelled"), false, false],
  ])("%s", (_label, p, turnActive, shown) => {
    const { container } = render(<PlanStrip plan={p} turnActive={turnActive} />);
    expect(container.textContent !== "").toBe(shown);
  });
});
