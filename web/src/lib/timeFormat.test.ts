// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { formatDateTime, formatTime, setHostHourCycle } from "./timeFormat";

const at = new Date(2026, 8, 28, 14, 5);
const useFormat = (timeFormat: string) => localStorage.setItem("aoe-web-settings", JSON.stringify({ timeFormat }));

afterEach(() => localStorage.clear());

describe("time format", () => {
  it("uses the chosen hour cycle, and on automatic the host's", () => {
    const hm = { hour: "2-digit", minute: "2-digit" } as const;
    const cases: [string, string | null, RegExp][] = [
      ["24h", "h12", /14:05/],
      ["12h", "h23", /0?2:05/],
      ["auto", "h23", /14:05/],
      ["auto", "h12", /0?2:05/],
    ];
    for (const [format, host, want] of cases) {
      useFormat(format);
      setHostHourCycle(host);
      expect(formatTime(at, hm), `${format}/${host}`).toMatch(want);
      expect(formatDateTime(at), `${format}/${host}`).toMatch(want);
    }
  });

  it("ignores a host hint it does not know", () => {
    useFormat("auto");
    setHostHourCycle("h24");
    expect(formatTime(at)).toBe(at.toLocaleTimeString([]));
  });
});
