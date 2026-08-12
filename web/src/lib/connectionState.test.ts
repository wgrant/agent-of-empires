import { describe, expect, it, vi } from "vitest";

import {
  getDashboardConnectionDiagnostics,
  isServerDown,
  reportDashboardConnectionFailure,
  reportDashboardConnectionSuccess,
} from "./connectionState";

describe("dashboard connection state", () => {
  it("retains the last confirmed AoE contact while a failure is in progress", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-12T13:04:00Z"));
      reportDashboardConnectionSuccess();
      expect(isServerDown()).toBe(false);

      vi.setSystemTime(new Date("2026-08-12T13:05:00Z"));
      reportDashboardConnectionFailure();
      expect(isServerDown()).toBe(true);
      expect(getDashboardConnectionDiagnostics()).toMatchObject({
        phase: "unavailable",
        lastSuccessAt: new Date("2026-08-12T13:04:00Z").getTime(),
        failureSince: new Date("2026-08-12T13:05:00Z").getTime(),
      });

      vi.setSystemTime(new Date("2026-08-12T13:06:00Z"));
      reportDashboardConnectionSuccess();
      expect(isServerDown()).toBe(false);
      expect(getDashboardConnectionDiagnostics()).toMatchObject({
        phase: "connected",
        lastSuccessAt: new Date("2026-08-12T13:06:00Z").getTime(),
        failureSince: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
