import { describe, expect, it } from "vitest";

import { hasOlderHistoryFromWatermark } from "./useAcpConnection";

describe("hasOlderHistoryFromWatermark", () => {
  it("recognizes cached recent-first cursors with older pages", () => {
    expect(hasOlderHistoryFromWatermark(0)).toBe(false);
    expect(hasOlderHistoryFromWatermark(1)).toBe(false);
    expect(hasOlderHistoryFromWatermark(2)).toBe(true);
    expect(hasOlderHistoryFromWatermark(42)).toBe(true);
  });
});
