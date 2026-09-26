import { describe, expect, it } from "vitest";

import { describeTurnUsage, formatTokens } from "./turnUsage";

describe("describeTurnUsage", () => {
  it("names the model, totals the turn, and splits it only when several models ran", () => {
    const opus = { model: "claude-opus-5-5", input: 8, output: 2_500, cache_read: 452_000, cache_write: 1_200 };
    const haiku = { model: "claude-haiku-4-5", input: 2, output: 50 };
    expect(
      describeTurnUsage("claude-opus-5-5", {
        input: 10,
        output: 2_550,
        cache_read: 452_000,
        cache_write: 1_200,
        by_model: [opus, haiku],
      }),
    ).toEqual([
      "Latest reply by claude-opus-5-5",
      "Last turn: 10 input · 452k cache read · 1.2k cache write · 2.5k output",
      "  claude-opus-5-5: 8 input · 452k cache read · 1.2k cache write · 2.5k output",
      "  claude-haiku-4-5: 2 input · 50 output",
    ]);
    expect(describeTurnUsage(null, { input: 900, output: 40, by_model: [haiku] })).toEqual([
      "Last turn: 900 input · 40 output",
    ]);
    expect(describeTurnUsage(null, null)).toEqual([]);
  });

  it.each([
    [999, "999"],
    [1_234, "1.2k"],
    [45_600, "46k"],
    [1_230_000, "1.23M"],
  ])("formats %d tokens as %s", (n, text) => {
    expect(formatTokens(n)).toBe(text);
  });
});
