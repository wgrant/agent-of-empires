import { describe, expect, it } from "vitest";

import { parseReviewFindings } from "./reviewFindings";

describe("parseReviewFindings", () => {
  it("reads a ReportFindings call's args and rejects anything else", () => {
    expect(
      parseReviewFindings({
        level: "medium",
        findings: [
          {
            file: "src/a.rs",
            line: 12,
            summary: "Leaks the fence",
            failure_scenario: "A reset strands the approval",
            category: "correctness",
            verdict: "CONFIRMED",
            outcome: "fixed",
          },
          { file: "src/b.rs", summary: "Unused import", failure_scenario: "" },
        ],
      }),
    ).toEqual({
      level: "medium",
      findings: [
        {
          file: "src/a.rs",
          line: 12,
          summary: "Leaks the fence",
          failureScenario: "A reset strands the approval",
          category: "correctness",
          verdict: "CONFIRMED",
          outcome: "fixed",
        },
        { file: "src/b.rs", summary: "Unused import" },
      ],
    });
    expect(parseReviewFindings({ findings: [] })).toEqual({ findings: [] });
    for (const args of [null, {}, { findings: "none" }, { findings: [{ file: "a.rs" }] }]) {
      expect(parseReviewFindings(args)).toBeNull();
    }
  });
});
