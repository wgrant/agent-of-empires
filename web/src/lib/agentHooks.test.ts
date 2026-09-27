import { describe, expect, it } from "vitest";

import { hookHeadline } from "./agentHooks";

describe("hookHeadline", () => {
  it("names a hook's run, and hides one that succeeded silently", () => {
    const hook = (status: string, exit_code?: number) => ({
      name: "PostToolUse:Edit",
      event: "PostToolUse",
      status,
      exit_code,
    });
    const cases: [ReturnType<typeof hook>, string, string | null][] = [
      [hook("running"), "", "Running PostToolUse:Edit hook"],
      [hook("success", 0), "\n", null],
      [hook("success", 0), "formatted 2 files\n", "PostToolUse:Edit hook: formatted 2 files"],
      [hook("error", 2), "\nlint failed\nmore", "PostToolUse:Edit hook failed (exit 2): lint failed"],
      [hook("error"), "", "PostToolUse:Edit hook failed"],
      [hook("cancelled"), "", "PostToolUse:Edit hook cancelled"],
    ];
    for (const [h, output, want] of cases) expect(hookHeadline(h, output)).toBe(want);
  });
});
