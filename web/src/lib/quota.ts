// Plan quota presentation: labels, the compact footer selection, and reset times.

import type { AgentQuota, QuotaWindow } from "./acpTypes";
import { formatDateTime } from "./timeFormat";

const HOUR_MINS = 60;
const DAY_MINS = 24 * HOUR_MINS;

/** "5h", "7d", "Opus 7d"; falls back to the window id when its length is unknown. */
export function quotaWindowLabel(window: QuotaWindow): string {
  const mins = window.duration_mins;
  let length: string;
  if (!mins) length = window.id;
  else if (mins % DAY_MINS === 0) length = `${mins / DAY_MINS}d`;
  else if (mins % HOUR_MINS === 0) length = `${mins / HOUR_MINS}h`;
  else length = `${mins}m`;
  return window.scope ? `${window.scope} ${length}` : length;
}

function hasReset(window: QuotaWindow, now: number): boolean {
  return window.resets_at != null && Date.parse(window.resets_at) <= now;
}

/** The windows worth a footer slot: the account-wide ones whose reading still applies. */
export function compactQuotaWindows(quota: AgentQuota | null, now: number): QuotaWindow[] {
  if (!quota) return [];
  const live = quota.windows.filter((window) => !hasReset(window, now));
  const accountWide = live.filter((window) => !window.scope);
  return accountWide.length > 0 ? accountWide : live.slice(0, 2);
}

export function quotaTone(usedPercent: number): string {
  if (usedPercent >= 90) return "text-rose-400";
  if (usedPercent >= 75) return "text-amber-400";
  return "text-text-dim";
}

function formatClock(at: Date, now: number): string {
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return formatDateTime(at, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < HOUR_MINS) return `${mins}m`;
  if (mins < DAY_MINS) return `${Math.floor(mins / HOUR_MINS)}h ${mins % HOUR_MINS}m`;
  return `${Math.floor(mins / DAY_MINS)}d ${Math.floor((mins % DAY_MINS) / HOUR_MINS)}h`;
}

/** One tooltip line per window, e.g. "5h: 62% used, resets 4:20 PM (in 37m)". */
export function describeQuotaWindow(window: QuotaWindow, now: number): string {
  const used = `${quotaWindowLabel(window)}: ${Math.round(window.used_percent)}% used`;
  if (!window.resets_at) return used;
  const resetsAt = new Date(window.resets_at);
  if (resetsAt.getTime() <= now) return `${used}, reset at ${formatClock(resetsAt, now)} (no reading since)`;
  return `${used}, resets ${formatClock(resetsAt, now)} (in ${formatDuration(resetsAt.getTime() - now)})`;
}

export function describeQuotaAge(quota: AgentQuota, now: number): string {
  const age = now - Date.parse(quota.observed_at);
  return age < 60_000 ? "Plan usage as of just now" : `Plan usage as of ${formatDuration(age)} ago`;
}
