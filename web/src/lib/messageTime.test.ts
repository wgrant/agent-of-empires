import { describe, expect, it } from "vitest";

import { messageTimeLabel } from "./messageTime";

describe("messageTimeLabel", () => {
  it("adds the date once a message is not from today, and the year once it is not from this year", () => {
    const now = new Date(2026, 8, 27, 15, 0);
    const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const today = new Date(2026, 8, 27, 9, 5);
    const yesterday = new Date(2026, 8, 26, 23, 59);
    const lastYear = new Date(2025, 11, 31, 8, 0);
    expect(messageTimeLabel(today, now)).toEqual({ date: null, time: time(today) });
    expect(messageTimeLabel(yesterday, now)).toEqual({
      date: yesterday.toLocaleDateString([], { month: "short", day: "numeric" }),
      time: time(yesterday),
    });
    expect(messageTimeLabel(lastYear, now).date).toContain("2025");
  });
});
