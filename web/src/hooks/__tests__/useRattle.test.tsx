// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRattle } from "../useRattle";

const RATTLE = { frames: ["a", "b", "c"], interval: 100 };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRattle", () => {
  // Frames count from the epoch, so two glyphs on one epoch keep step; under
  // reduced motion the glyph holds its first frame.
  it.each([
    [false, ["b", "c", "a"]],
    [true, ["a", "a", "a"]],
  ])("reduced motion %s shows %j", (reduce, want) => {
    vi.useFakeTimers({ now: 1_000 });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: reduce && query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    const { result } = renderHook(() => useRattle(RATTLE, 900));
    const seen = [result.current];
    for (let i = 0; i < 2; i++) {
      act(() => vi.advanceTimersByTime(100));
      seen.push(result.current);
    }
    expect(seen).toEqual(want);
  });
});
