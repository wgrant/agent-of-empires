import { useCallback, useEffect, useMemo, useState } from "react";

import type { ActivityRow } from "../lib/acpTypes";
import {
  DEFAULT_HISTORY_WINDOW,
  historyWindow,
  historyWindowStart,
  nextHistoryWindowSize,
} from "../lib/acpHistoryWindow";

const MAX_REMEMBERED_HISTORY_WINDOWS = 50;
const rememberedHistoryWindows = new Map<string, number>();

function rememberedHistoryWindow(sessionId: string): number {
  const value = rememberedHistoryWindows.get(sessionId);
  if (value === undefined) return DEFAULT_HISTORY_WINDOW;
  rememberedHistoryWindows.delete(sessionId);
  rememberedHistoryWindows.set(sessionId, value);
  return Math.min(value, MAX_HISTORY_WINDOW);
}

function rememberHistoryWindow(sessionId: string, visibleRows: number): void {
  if (!sessionId) return;
  rememberedHistoryWindows.delete(sessionId);
  rememberedHistoryWindows.set(sessionId, Math.min(visibleRows, MAX_HISTORY_WINDOW));
  while (rememberedHistoryWindows.size > MAX_REMEMBERED_HISTORY_WINDOWS) {
    const oldest = rememberedHistoryWindows.keys().next().value;
    if (oldest === undefined) break;
    rememberedHistoryWindows.delete(oldest);
  }
}

/** Test isolation for the module-level remount cache. */
export function clearRememberedHistoryWindows(): void {
  rememberedHistoryWindows.clear();
}

export interface HistoryWindowState {
  /** The bounded slice of `activity` to render. */
  windowedActivity: ActivityRow[];
  /** True when older rows remain that "Load earlier" would reveal. */
  canLoadEarlier: boolean;
  /** True when newer rows remain below the current range. */
  canLoadNewer: boolean;
  /** Reveal an additional chunk of older history. */
  loadEarlier: () => void;
  /** Move the bounded range toward the live tail. */
  loadNewer: () => void;
  /** Re-anchor the bounded range at the live tail in one step. */
  jumpToLatest: () => void;
  /** Advances when the bounded range is explicitly navigated or an older
   *  server page prepends it. Consumers that retain index-based resources use
   *  this as an atomic replacement boundary. */
  generation: number;
}

export interface HistoryWindowDebugSnapshot {
  sessionId: string;
  activityRows: number;
  visibleRows: number;
  windowEnd: number;
  start: number;
  pinnedStart: number | null;
  generation: number;
  canLoadEarlier: boolean;
  canLoadNewer: boolean;
  firstRenderedRowId: string | null;
  lastRenderedRowId: string | null;
}

/** An explicitly expanded transcript stays useful without mounting an
 * unbounded number of rich message cards. Each navigator move overlaps the
 * preceding range by one normal history step. */
export const MAX_HISTORY_WINDOW = DEFAULT_HISTORY_WINDOW * 2;

/**
 * Window the structured-view transcript to its most recent rows so a
 * long session does not block first paint, growing on demand via
 * `loadEarlier`. Expanded windows are remembered per session so switching
 * away and back does not repeatedly hide rows the user already revealed.
 * Only explicit reveals are remembered: temporary growth that keeps the
 * current top stable while live rows arrive must not make every future open
 * render an increasingly large transcript.
 * The view remounts under `key={sessionId}`, so this cache must live at module
 * scope rather than in hook state. See #2144 and #2236.
 *
 * The window grows by however many rows are added after first paint when
 * `preserveStartOnGrowth` is true (live turns appended at the tail, or an
 * older page prepended at the head), so rows already on screen stay put.
 * Initial warm-cache replay passes false: missed rows then re-anchor the
 * remembered depth at the fresh tail instead of making the whole catch-up
 * visible. See #2236.
 */
export function useHistoryWindow(
  sessionId: string,
  activity: ActivityRow[],
  showClearedTurns: boolean,
  preserveStartOnGrowth = true,
): HistoryWindowState {
  const [visibleRows, setVisibleRows] = useState(() => rememberedHistoryWindow(sessionId));
  const [windowEnd, setWindowEnd] = useState(() => activity.length);
  // The normal row budget is re-cut at a user-turn boundary. Preserve the
  // actual cut while this range follows a live tail, otherwise a huge prior
  // turn can make the first new prompt hide the rows already on screen.
  const [pinnedStart, setPinnedStart] = useState<number | null>(null);
  const [windowSessionId, setWindowSessionId] = useState(sessionId);
  const [generation, setGeneration] = useState(0);
  const [previousRows, setPreviousRows] = useState(() => ({
    length: activity.length,
    firstId: activity[0]?.id ?? null,
    lastId: activity.at(-1)?.id ?? null,
  }));
  if (windowSessionId !== sessionId) {
    setWindowSessionId(sessionId);
    setVisibleRows(rememberedHistoryWindow(sessionId));
    setWindowEnd(activity.length);
    setPinnedStart(null);
    setGeneration(0);
    setPreviousRows({ length: activity.length, firstId: activity[0]?.id ?? null, lastId: activity.at(-1)?.id ?? null });
  } else if (
    previousRows.length !== activity.length ||
    previousRows.firstId !== (activity[0]?.id ?? null) ||
    previousRows.lastId !== (activity.at(-1)?.id ?? null)
  ) {
    const growth = activity.length - previousRows.length;
    const initialPopulation = previousRows.length === 0 && activity.length > 0;
    const prepended = growth > 0 && previousRows.lastId === (activity.at(-1)?.id ?? null);
    const appended = growth > 0 && previousRows.firstId === (activity[0]?.id ?? null);
    if (initialPopulation) {
      // A production WebSocket replay can batch its whole first page into one
      // React render. There is no prior row identity to classify that change
      // as an append, but the new transcript is still tail-anchored.
      setWindowEnd(activity.length);
      setPinnedStart(null);
    } else if (prepended) {
      // Keep the reader on the same rows when an older server page is added.
      setWindowEnd((end) => Math.min(activity.length, end + growth));
      if (pinnedStart !== null) setPinnedStart(pinnedStart + growth);
      // This replaces the external runtime's bounded source range. Live tail
      // appends deliberately do not advance this generation. See #2236.
      setGeneration((current) => current + 1);
    } else if (appended && windowEnd === previousRows.length) {
      // Follow a live tail only while this range already includes it. Keep the
      // reader's current top stable until the bounded range is full; after
      // that, the bottom navigator makes newer rows explicit instead of
      // silently mounting an unbounded transcript.
      setWindowEnd(activity.length);
      if (preserveStartOnGrowth) {
        const priorEnd = Math.min(windowEnd, previousRows.length);
        setPinnedStart(pinnedStart ?? historyWindowStart(activity, visibleRows, priorEnd));
        setVisibleRows((rows) => Math.min(MAX_HISTORY_WINDOW, rows + growth));
      } else {
        setPinnedStart(null);
      }
    } else if (growth < 0) {
      setWindowEnd((end) => Math.min(end, activity.length));
    }
    setPreviousRows({ length: activity.length, firstId: activity[0]?.id ?? null, lastId: activity.at(-1)?.id ?? null });
  }
  const boundedEnd = Math.min(windowEnd, activity.length);
  const { start, canLoadEarlier } = useMemo(
    () => historyWindow(activity, visibleRows, showClearedTurns, boundedEnd, pinnedStart),
    [activity, boundedEnd, visibleRows, showClearedTurns, pinnedStart],
  );
  const windowedActivity = useMemo(() => activity.slice(start, boundedEnd), [activity, boundedEnd, start]);
  const canLoadNewer = boundedEnd < activity.length;
  // Read-only browser-console aid for diagnosing a production history jump.
  // The transcript cache tells us whether rows exist; this adds the separate
  // question of which bounded range the hook intended to mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const debugWindow = window as typeof window & {
      __aoeDebug?: { historyWindow?: () => HistoryWindowDebugSnapshot };
    };
    const historyWindow = () => ({
      sessionId,
      activityRows: activity.length,
      visibleRows,
      windowEnd: boundedEnd,
      start,
      pinnedStart,
      generation,
      canLoadEarlier,
      canLoadNewer,
      firstRenderedRowId: windowedActivity[0]?.id ?? null,
      lastRenderedRowId: windowedActivity.at(-1)?.id ?? null,
    });
    debugWindow.__aoeDebug = {
      ...debugWindow.__aoeDebug,
      historyWindow,
    };
    return () => {
      if (debugWindow.__aoeDebug?.historyWindow === historyWindow) delete debugWindow.__aoeDebug.historyWindow;
    };
  }, [
    activity.length,
    boundedEnd,
    canLoadEarlier,
    canLoadNewer,
    generation,
    pinnedStart,
    sessionId,
    start,
    visibleRows,
    windowedActivity,
  ]);
  const loadEarlier = useCallback(() => {
    setGeneration((current) => current + 1);
    setPinnedStart(null);
    if (visibleRows < MAX_HISTORY_WINDOW) {
      const next = nextHistoryWindowSize(activity, visibleRows, boundedEnd);
      if (next <= MAX_HISTORY_WINDOW) {
        setVisibleRows(() => {
          rememberHistoryWindow(sessionId, next);
          return next;
        });
        return;
      }
    }
    // Once the local range reaches its bounded maximum, page the range
    // itself backward by one overlapping step. Do not jump to the previous
    // user prompt: a `/goal` can contain thousands of visual blocks beneath
    // one prompt, and that old boundary would skip a large middle span.
    setVisibleRows(MAX_HISTORY_WINDOW);
    setWindowEnd(() => Math.max(0, boundedEnd - DEFAULT_HISTORY_WINDOW));
  }, [activity, boundedEnd, sessionId, visibleRows]);
  const loadNewer = useCallback(() => {
    setGeneration((current) => current + 1);
    setPinnedStart(null);
    setVisibleRows(MAX_HISTORY_WINDOW);
    setWindowEnd((end) => Math.min(activity.length, end + DEFAULT_HISTORY_WINDOW));
  }, [activity.length]);
  const jumpToLatest = useCallback(() => {
    setGeneration((current) => current + 1);
    setPinnedStart(null);
    setVisibleRows(MAX_HISTORY_WINDOW);
    setWindowEnd(activity.length);
  }, [activity.length]);
  return {
    windowedActivity,
    canLoadEarlier,
    canLoadNewer,
    loadEarlier,
    loadNewer,
    jumpToLatest,
    generation,
  };
}
