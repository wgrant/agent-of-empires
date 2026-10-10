// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CompactionCacheTiming } from "./CompactionCacheTiming";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("ages the cache estimate despite frequent snapshot refreshes and dates old observations", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
  const cache = {
    refreshedAt: Date.now() - 86400000,
    expiresAt: Date.now() + 10000,
    ttlMs: 3600000,
    contextTokens: 211000,
  };
  const view = render(<CompactionCacheTiming cache={cache} enabled />);
  expect(screen.getByText(/Cache timing · estimated expiry/)).toBeTruthy();
  expect(screen.getByText(/Oct 9/)).toBeTruthy();
  for (let i = 0; i < 5; i++) {
    act(() => vi.advanceTimersByTime(2000));
    view.rerender(<CompactionCacheTiming cache={{ ...cache }} enabled />);
  }
  expect(screen.getByText("Cache timing · expired")).toBeTruthy();
  view.rerender(<CompactionCacheTiming cache={undefined} enabled />);
  expect(screen.getByText("Cache timing · unavailable")).toBeTruthy();
  expect(screen.getByText(/Unknown timing is skipped/)).toBeTruthy();
});
