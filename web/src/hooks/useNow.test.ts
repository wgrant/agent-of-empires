// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./useNow";

describe("useNow", () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it("refreshes as soon as it becomes active, not on the first interval", () => {
    const { result, rerender } = renderHook(({ active }) => useNow(15_000, active), {
      initialProps: { active: false },
    });
    expect(result.current).toBe(0);
    vi.setSystemTime(30 * 60_000);
    rerender({ active: true });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe(30 * 60_000);
  });
});
