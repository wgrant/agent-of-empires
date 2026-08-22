// Pure helpers for the structured view's "load earlier" and scroll-up auto-load.

/** Distance from the top that triggers a preload, and the minimum overflow for auto-load. */
export const HISTORY_PRELOAD_PX = 200;

/** Without a cooldown, restoring scroll near the top re-fires the load every frame. */
export const HISTORY_AUTOLOAD_COOLDOWN_MS = 500;

export interface AutoLoadInput {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Re-armed once the user scrolls away from the top. */
  armed: boolean;
  canLoadEarlier: boolean;
  /** Whether this sample follows an actual viewport scroll. The initial
   *  mount sample establishes scroll state but must not be mistaken for an
   *  arrival at the top. */
  hasScrolled: boolean;
  /** Whether this scroll moved toward the transcript's top boundary. */
  movingTowardTop: boolean;
  now: number;
  lastLoadAt: number;
}

export interface AutoLoadDecision {
  armed: boolean;
  fire: boolean;
}

/** Fires only when the transcript overflows, once per arming and cooldown window. */
export function autoLoadDecision(i: AutoLoadInput): AutoLoadDecision {
  // The controller deliberately survives an assistant-ui runtime remount.
  // Observing a fresh viewport is not a reader moving away from the top, so
  // it must not re-arm a request that just consumed the current arming. A
  // later real scroll beyond the preload boundary performs that re-arm.
  if (!i.hasScrolled) return { armed: i.armed, fire: false };
  const overflowing = i.scrollHeight > i.clientHeight + HISTORY_PRELOAD_PX;
  if (!overflowing || i.scrollTop > HISTORY_PRELOAD_PX) {
    return { armed: true, fire: false };
  }
  // A reader leaving the top of a newly revealed range can still be within
  // the preload zone for a few pixels. Only an upward arrival asks for older
  // history; a downward scroll must be allowed to enter the newer range.
  if (!i.movingTowardTop) return { armed: i.armed, fire: false };
  if (i.armed && i.canLoadEarlier && i.now - i.lastLoadAt > HISTORY_AUTOLOAD_COOLDOWN_MS) {
    return { armed: false, fire: true };
  }
  return { armed: i.armed, fire: false };
}

/** Absorbs sub-pixel rounding and reflows. */
export const PINNED_BOTTOM_SLOP_PX = 16;

export function isPinnedToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  slop: number = PINNED_BOTTOM_SLOP_PX,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - slop;
}

/** Keeps the read position after older rows grow the top; 0 when pinned to the bottom. */
export function scrollRestoreDelta(prevScrollHeight: number, nextScrollHeight: number, atBottom: boolean): number {
  if (atBottom) return 0;
  const delta = nextScrollHeight - prevScrollHeight;
  return delta > 0 ? delta : 0;
}

/** A pending height anchor is stale when loading has settled but the
 * transcript never grew. Keeping it would apply an unrelated later append as
 * though it were older history. */
export function anchorIsStale(loading: boolean, anchor: number | null, scrollHeight: number): boolean {
  return !loading && anchor != null && anchor === scrollHeight;
}

/** Restore an explicit older-history request after the replacement window has
 * mounted. Unlike a live append, the reader asked to reveal content above the
 * current view, so retain the same prior row even if the runtime briefly
 * auto-scrolls while replacing its resource tree. */
export function restoreEarlierHistoryScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  // At the top boundary the reader asked for older messages. Leaving them at
  // the old first row, now far below the newly revealed page, looks like an
  // arbitrary jump and hides the content they requested. Mid-transcript
  // readers, however, retain their exact prior row.
  if (previousScrollTop <= HISTORY_PRELOAD_PX) return 0;
  return previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
}

/** Scroll adjustment for a transient inset at the transcript's top. Readers
 * who are already at the top deliberately see the new breathing room; readers
 * partway through the transcript keep the same row under their eyes. The same
 * rule will be used by the history-loading affordance when it gains a floating
 * progress indicator. */
export function topInsetScrollAdjustment(previousInset: number, nextInset: number, scrollTop: number): number {
  if (scrollTop <= previousInset + 4) return 0;
  return nextInset - previousInset;
}

export type EarlierAction = "reveal" | "fetch" | "none";

/** Reveal already-loaded rows first, then fetch an older page. */
export function earlierAction(canRevealLoaded: boolean, hasMoreOlder: boolean): EarlierAction {
  if (canRevealLoaded) return "reveal";
  if (hasMoreOlder) return "fetch";
  return "none";
}

export function canOfferEarlier(canRevealLoaded: boolean, hasMoreOlder: boolean): boolean {
  return canRevealLoaded || hasMoreOlder;
}
/** A settled load that didn't grow the transcript; left set it would jump the viewport on the next live append. */
export function anchorIsStale(loading: boolean, anchor: number | null, scrollHeight: number): boolean {
  return !loading && anchor != null && anchor === scrollHeight;
}
