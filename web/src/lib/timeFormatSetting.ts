// The time format preference, stored with the other web settings.

export type TimeFormat = "auto" | "12h" | "24h";
export const TIME_FORMATS: readonly TimeFormat[] = ["auto", "12h", "24h"];
export const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
  auto: "Automatic",
  "12h": "12-hour",
  "24h": "24-hour",
};

export function parseTimeFormat(value: unknown): TimeFormat | null {
  return TIME_FORMATS.includes(value as TimeFormat) ? (value as TimeFormat) : null;
}
