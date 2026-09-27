import { describe, expect, it } from "vitest";

import { hasOlderHistoryFromWatermark, lastActivityAt } from "./useAcpConnection";

describe("hasOlderHistoryFromWatermark", () => {
  it("recognizes cached recent-first cursors with older pages", () => {
    expect(hasOlderHistoryFromWatermark(0)).toBe(false);
    expect(hasOlderHistoryFromWatermark(1)).toBe(false);
    expect(hasOlderHistoryFromWatermark(2)).toBe(true);
    expect(hasOlderHistoryFromWatermark(42)).toBe(true);
  });
});

describe("lastActivityAt", () => {
  it("resumes from the session's last event, never later than now", () => {
    const now = Date.parse("2026-09-27T06:00:00Z");
    expect(lastActivityAt("2026-09-27T05:59:20Z", now)).toBe(now - 40_000);
    expect(lastActivityAt("2026-09-27T06:00:05Z", now)).toBe(now);
    expect(lastActivityAt(null, now)).toBe(now);
  });
});
