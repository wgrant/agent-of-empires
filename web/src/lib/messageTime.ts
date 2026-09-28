import { formatTime } from "./timeFormat";

/** A message's time, with its date once it is not from today. */
export function messageTimeLabel(at: Date, now: Date = new Date()): { date: string | null; time: string } {
  const time = formatTime(at, { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === now.toDateString()) return { date: null, time };
  const date = at.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return { date, time };
}
