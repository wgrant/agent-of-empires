import type { ActivityRow } from "./acpTypes";

/** Recent activity rows the structured view paints on open. Older rows
 *  stay in reducer state but are not rendered until the user loads them,
 *  so a long transcript no longer blocks first paint on mobile. The
 *  whole-history fetch + reduce still happens (proposal A in #2144); the
 *  multi-page network cost on very large sessions is a separate
 *  follow-up. See #2144. */
export const DEFAULT_HISTORY_WINDOW = 150;

/** Extra rows revealed per "Load earlier" activation. */
export const HISTORY_WINDOW_STEP = 150;

/** A transcript card that is complete enough to safely start after. A user
 * turn is one useful boundary, but long `/goal` turns can contain thousands
 * of rows, so it must not be the only one. In particular, completed tool
 * cards let the navigator reveal a long turn incrementally. */
function endsVisualBlock(row: ActivityRow): boolean {
  switch (row.kind) {
    case "tool_complete":
    case "tool_error":
    case "tool_stopped":
    case "message":
    case "thinking":
    case "user_prompt":
    case "user_diff_comments":
    case "elicitation_answered":
    case "empty_output":
    case "context_reset":
    case "session_cleared":
    case "compacted":
    case "summary":
      return true;
    case "tool_start":
      return false;
  }
}

/** Index of the newest user turn boundary, or -1 when there is none. */
export function lastUserBoundaryIndex(rows: readonly ActivityRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.kind === "user_prompt" || rows[i]!.kind === "user_diff_comments") return i;
  }
  return -1;
}

/**
 * Rows the window should open with: `defaultWindow`, widened so the whole
 * last turn is on screen when that turn alone is longer than the default.
 *
 * The user's most recent prompt and everything the agent did in reply
 * are the context that is always relevant on (re)opening a session; with
 * the flat default a tool-heavy turn came up cut mid-way and took several
 * "Load earlier" clicks to reach its own prompt. Older turns keep the
 * default treatment (windowed out, revealed on demand), so a long backlog
 * still does not block first paint. Bounded by what is loaded: rows beyond
 * the recent-first tail page are reached via the server fetch as before.
 */
export function initialHistoryWindow(
  rows: readonly ActivityRow[],
  defaultWindow: number = DEFAULT_HISTORY_WINDOW,
): number {
  const boundary = lastUserBoundaryIndex(rows);
  if (boundary < 0) return defaultWindow;
  return Math.max(defaultWindow, rows.length - boundary);
}

/** Do not scan all the way through an enormous turn merely to find a tidy
 * boundary. The hard cap is more useful than skipping hundreds of visible
 * rows in pursuit of the next user prompt. */
const SAFE_CUT_LOOKAHEAD = 32;

/** Pull `start` back so the window never opens strictly between a
 *  sub-agent `Task` row and its child tool calls. The child rows carry
 *  `tool.parent_tool_call_id` (the parent Task's `tool.id`); when `start`
 *  lands on such a child whose parent sits earlier, the parent has been
 *  folded into "earlier" and the children render as headless orphan
 *  cards instead of one SubagentCard (#2313). Walk the parent chain back
 *  to the top-level Task. Most visual-block boundaries carry no `tool`, so
 *  the loop is normally a no-op.
 *
 *  ponytail: linear scan per hop, bounded by the sub-agent block, only
 *  runs at the window cut. A sub-agent with more child rows than the
 *  whole window pulls `start` back past the cap, rendering the full
 *  block; a headless run of orphan cards is the worse outcome. */
function snapBackToSubagentParent(rows: readonly ActivityRow[], start: number): number {
  let s = start;
  while (s > 0) {
    const parentId = rows[s]?.tool?.parent_tool_call_id;
    if (!parentId) break;
    let parentIdx = -1;
    for (let i = s - 1; i >= 0; i -= 1) {
      if (rows[i]!.kind === "tool_start" && rows[i]!.tool?.id === parentId) {
        parentIdx = i;
        break;
      }
    }
    if (parentIdx < 0) break;
    s = parentIdx;
  }
  return s;
}

/**
 * Index into `rows` from which the transcript should render, given how
 * many recent rows the caller wants visible (`visibleRows`).
 *
 * The hard cap is primary: the result is never below
 * `rows.length - visibleRows`, so a single huge agent turn (hundreds of
 * tool rows under one prompt) can never blow the window past the cap.
 * Within a short lookahead after that cap the start prefers the end of a
 * completed visual block. This is deliberately not a user-turn boundary:
 * `/goal` and autonomous work can make one user turn huge, and a window
 * should page through its completed tool/message blocks rather than skip to
 * the next prompt. When no nearby safe cut exists, use the cap as-is, then
 * pull it back only when necessary to keep a sub-agent with its parent
 * (#2313).
 *
 * Returns 0 when every row fits (nothing earlier to load).
 */
export function historyWindowStart(rows: readonly ActivityRow[], visibleRows: number, end = rows.length): number {
  if (visibleRows <= 0) return 0;
  const boundedEnd = Math.min(Math.max(0, end), rows.length);
  const cap = Math.max(0, boundedEnd - visibleRows);
  if (cap === 0) return 0;
  let start = cap;
  const searchEnd = Math.min(boundedEnd, cap + SAFE_CUT_LOOKAHEAD);
  for (let i = cap; i <= searchEnd; i += 1) {
    if (i > 0 && endsVisualBlock(rows[i - 1]!)) {
      start = i;
      break;
    }
  }
  return snapBackToSubagentParent(rows, start);
}

/**
 * Grow the row allowance enough for "Load earlier" to move the effective
 * render boundary. A fixed-size increment can otherwise return the same
 * sub-agent-parent cut repeatedly, making the control appear to do nothing.
 * Initial rendering still observes the default cap; only an explicit reveal
 * may cross more than one step to reach a new cut.
 */
export function nextHistoryWindowSize(rows: readonly ActivityRow[], visibleRows: number, end = rows.length): number {
  const boundedEnd = Math.min(Math.max(0, end), rows.length);
  const currentStart = historyWindowStart(rows, visibleRows, boundedEnd);
  let next = Math.min(boundedEnd, visibleRows + HISTORY_WINDOW_STEP);
  while (next < boundedEnd && historyWindowStart(rows, next, boundedEnd) === currentStart) {
    next = Math.min(boundedEnd, next + HISTORY_WINDOW_STEP);
  }
  return next;
}

/** Index of the latest `/clear` divider, or -1 when there is none. The fold
 *  pins to the LAST clear so repeated /clears collapse cumulatively. The
 *  message tree, the runtime key, and the ClearedTurnsBanner all measure the
 *  fold from here, so they cannot disagree. See #1101. */
export function lastClearIndex(rows: readonly ActivityRow[]): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.kind === "session_cleared") return i;
  }
  return -1;
}

export interface HistoryWindow {
  /** Index to start rendering from; 0 renders the whole transcript. */
  start: number;
  /** Whether older rows remain that "Load earlier" would actually
   *  reveal. False when the only hidden rows are pre-`/clear` (those are
   *  reached via the ClearedTurnsBanner), so the control is not a no-op. */
  canLoadEarlier: boolean;
}

/** Resolve the render window for the structured-view transcript. */
export function historyWindow(
  rows: readonly ActivityRow[],
  visibleRows: number,
  showClearedTurns: boolean,
  end = rows.length,
  pinnedStart?: number | null,
): HistoryWindow {
  const calculatedStart = historyWindowStart(rows, visibleRows, end);
  // A live tail may grow across a very large turn. Re-running the
  // forward boundary snap in that case can skip straight to the newly
  // appended user prompt, hiding every row the reader was just seeing.
  // The caller pins its already-rendered top for that one live range;
  // explicit history navigation clears it and returns to normal cuts.
  const boundedEnd = Math.min(Math.max(0, end), rows.length);
  const start = pinnedStart == null ? calculatedStart : Math.min(Math.max(0, Math.floor(pinnedStart)), boundedEnd);
  // Pre-`/clear` rows are reached via the ClearedTurnsBanner, not by "Load
  // earlier", so they must not make that control look live.
  const clearIndex = showClearedTurns ? -1 : lastClearIndex(rows);
  const canLoadEarlier = clearIndex < 0 ? start > 0 : start > clearIndex;
  return { start, canLoadEarlier };
}
