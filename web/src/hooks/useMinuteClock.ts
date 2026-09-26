import { useSyncExternalStore } from "react";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => {
    for (const notify of listeners) notify();
  }, MINUTE_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Rounded down so the snapshot stays stable between ticks. */
function getSnapshot() {
  return Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
}

/** Wall-clock milliseconds to the minute, re-rendering subscribers once a minute. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
