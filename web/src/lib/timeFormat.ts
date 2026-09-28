// Clock times in the user's hour cycle. Browsers take it from the locale and
// ignore an OS 24-hour setting, so "auto" defers to the host's own preference
// when the server reports one.

import { safeGetItem, safeSetItem } from "./safeStorage";
import { parseTimeFormat, type TimeFormat } from "./timeFormatSetting";

type HourCycle = "h12" | "h23";
// Kept across loads so the first render after a reload already uses it.
const HOST_KEY = "aoe-host-hour-cycle";

export function setHostHourCycle(cycle: string | null | undefined): void {
  safeSetItem(HOST_KEY, cycle === "h12" || cycle === "h23" ? cycle : "");
}

/** Read from storage rather than the settings hook, so plain modules can format times. */
function chosenFormat(): TimeFormat {
  try {
    return parseTimeFormat(JSON.parse(safeGetItem("aoe-web-settings") ?? "{}")?.timeFormat) ?? "auto";
  } catch {
    return "auto";
  }
}

function hourCycle(): HourCycle | undefined {
  const format = chosenFormat();
  if (format === "12h") return "h12";
  if (format === "24h") return "h23";
  const host = safeGetItem(HOST_KEY);
  return host === "h12" || host === "h23" ? host : undefined;
}

function withHourCycle(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const cycle = hourCycle();
  return cycle ? { ...options, hourCycle: cycle } : options;
}

export function formatTime(at: Date, options: Intl.DateTimeFormatOptions = {}): string {
  return at.toLocaleTimeString([], withHourCycle(options));
}

export function formatDateTime(at: Date, options: Intl.DateTimeFormatOptions = {}): string {
  return at.toLocaleString([], withHourCycle(options));
}
