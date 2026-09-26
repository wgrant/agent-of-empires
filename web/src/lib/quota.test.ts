import { describe, expect, it } from "vitest";

import type { AgentQuota, QuotaWindow } from "./acpTypes";
import { compactQuotaWindows, describeQuotaAge, describeQuotaWindow, quotaTone, quotaWindowLabel } from "./quota";

const NOW = Date.parse("2026-09-26T03:43:00Z");
const inMins = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

function win(id: string, duration: number | null, used: number, resetsIn: number | null, scope?: string): QuotaWindow {
  return {
    id,
    duration_mins: duration,
    scope: scope ?? null,
    used_percent: used,
    resets_at: resetsIn === null ? null : inMins(resetsIn),
  };
}

function quota(windows: QuotaWindow[]): AgentQuota {
  return { windows, limited: false, observed_at: inMins(-12) };
}

describe("quotaWindowLabel", () => {
  it.each([
    [win("five_hour", 300, 0, null), "5h"],
    [win("seven_day", 10080, 0, null), "7d"],
    [win("seven_day_opus", 10080, 0, null, "Opus"), "Opus 7d"],
    [win("odd", 90, 0, null), "90m"],
    [win("mystery", null, 0, null), "mystery"],
  ])("labels %o as %s", (window, label) => {
    expect(quotaWindowLabel(window)).toBe(label);
  });
});

describe("compactQuotaWindows", () => {
  it("keeps account-wide windows whose reading still applies", () => {
    const q = quota([
      win("five_hour", 300, 62, 37),
      win("seven_day", 10080, 7, 60 * 24 * 5),
      win("seven_day_opus", 10080, 50, 60 * 24 * 5, "Opus"),
    ]);
    expect(compactQuotaWindows(q, NOW).map((w) => w.id)).toEqual(["five_hour", "seven_day"]);
  });

  it("drops a window whose reset has passed, and falls back to scoped windows", () => {
    const q = quota([win("five_hour", 300, 99, -5), win("gpt/primary", 300, 40, 30, "GPT-6 Astra")]);
    expect(compactQuotaWindows(q, NOW).map((w) => w.id)).toEqual(["gpt/primary"]);
    expect(compactQuotaWindows(null, NOW)).toEqual([]);
  });
});

describe("tooltip text", () => {
  it("describes use, the reset, and a reset that has already happened", () => {
    expect(describeQuotaWindow(win("five_hour", 300, 61.6, 37), NOW)).toMatch(/^5h: 62% used, resets .+ \(in 37m\)$/);
    expect(describeQuotaWindow(win("seven_day", 10080, 7, 60 * 26), NOW)).toMatch(/\(in 1d 2h\)$/);
    expect(describeQuotaWindow(win("five_hour", 300, 99, -5), NOW)).toMatch(/reset at .+ \(no reading since\)$/);
    expect(describeQuotaWindow(win("x", 300, 3, null), NOW)).toBe("5h: 3% used");
    expect(describeQuotaAge(quota([]), NOW)).toBe("Plan usage as of 12m ago");
  });

  it.each([
    [10, "text-text-dim"],
    [75, "text-amber-400"],
    [90, "text-rose-400"],
  ])("tones %d%% as %s", (used, tone) => {
    expect(quotaTone(used)).toBe(tone);
  });
});
