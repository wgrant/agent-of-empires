import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

import { useIsCoarsePointer } from "../../hooks/useIsCoarsePointer";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { loadScrollState, restoredScrollTop, saveScrollState } from "../../lib/acpScrollState";
import { autoLoadDecision, isPinnedToBottom, restoreEarlierHistoryScrollTop } from "../../lib/historyScroll";
import { promptRepinDecision } from "../../lib/promptRepin";
import { repinOnResize } from "../../lib/repinOnResize";
import type { HistoryNavigationController, HistoryScrollAnchor } from "./AcpRuntime";

const HISTORY_AUTOPAGING_SETTLE_MS = 600;

/** Stick-to-bottom, earlier-history auto-load, and PWA-reopen scroll restore
 *  for the transcript viewport. These observers own bottom-following; the
 *  viewport primitive's own auto-scroll must stay disabled. */
export function useTranscriptScroll({
  sessionId,
  canLoadEarlierHistory,
  loadEarlierHistory,
  publishedTranscriptGeneration,
  historyScrollAnchorRef,
  historyNavigationControllerRef,
  composerCollapsed,
  promptSeq,
  hasEverOpened,
  localInflight,
}: {
  sessionId: string;
  canLoadEarlierHistory: boolean;
  loadEarlierHistory: () => void;
  publishedTranscriptGeneration: number;
  historyScrollAnchorRef: MutableRefObject<HistoryScrollAnchor | null>;
  historyNavigationControllerRef: MutableRefObject<HistoryNavigationController>;
  composerCollapsed: boolean;
  /** Counts every prompt once, from any path or device; keys the submit re-pin. */
  promptSeq: number;
  hasEverOpened: boolean;
  /** This client has an optimistic prompt row still awaiting its server echo. */
  localInflight: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const belowViewportRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  // Sampled on scroll: by the time a ResizeObserver fires, layout has already
  // settled, so pinned-ness must be read before the resize.
  const wasAtBottomRef = useRef<boolean>(true);
  // Last time we sampled at the bottom. iOS fires an interim scroll during a
  // keyboard resize that clears `wasAtBottomRef` but cannot clear this.
  const lastAtBottomAtRef = useRef(0);
  const didRestoreScrollRef = useRef(false);
  const [atBottom, setAtBottom] = useState(true);
  const { keyboardOpen } = useMobileKeyboard();
  const isCoarse = useIsCoarsePointer();
  const jumpToBottomUntilRef = useRef(0);

  /** An explicit "stick again": a programmatic scroll fires no gesture, so set
   *  the stick intent directly. */
  const pinToBottom = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    wasAtBottomRef.current = true;
    jumpToBottomUntilRef.current = performance.now() + 500;
    lastAtBottomAtRef.current = performance.now();
    setAtBottom(true);
    vp.scrollTop = vp.scrollHeight;
    requestAnimationFrame(() => {
      wasAtBottomRef.current = true;
      setAtBottom(true);
      vp.scrollTop = vp.scrollHeight;
    });
  }, []);
  const scrollToBottom = useCallback(() => pinToBottom(), [pinToBottom]);

  // A new prompt re-engages stick-to-bottom, as the CLI does: on a fine pointer
  // the composer growing while typing can drop the pinned intent. See
  // `promptRepinDecision` for why replayed prompts do not count.
  const seenPromptSeqRef = useRef<number | null>(null);
  useEffect(() => {
    const d = promptRepinDecision({
      seen: seenPromptSeqRef.current,
      promptSeq,
      live: hasEverOpened,
      localInflight,
    });
    seenPromptSeqRef.current = d.seen;
    if (d.pin) pinToBottom();
  }, [promptSeq, hasEverOpened, localInflight, pinToBottom]);

  // Mirrors so the scroll effect sees the latest load wiring without re-subscribing.
  const canLoadEarlierRef = useRef(canLoadEarlierHistory);
  const loadEarlierRef = useRef(loadEarlierHistory);
  const publishedTranscriptGenerationRef = useRef(publishedTranscriptGeneration);
  useEffect(() => {
    canLoadEarlierRef.current = canLoadEarlierHistory;
    loadEarlierRef.current = loadEarlierHistory;
  }, [canLoadEarlierHistory, loadEarlierHistory]);
  useEffect(() => {
    publishedTranscriptGenerationRef.current = publishedTranscriptGeneration;
  }, [publishedTranscriptGeneration]);
  const lastSampledScrollTopRef = useRef<number | null>(null);
  const userScrollInputRef = useRef(false);
  const autoPagingEligibleAtRef = useRef(0);

  const requestEarlierHistory = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp || !canLoadEarlierRef.current) return;
    historyNavigationControllerRef.current.lastLoadAt = performance.now();
    historyScrollAnchorRef.current = {
      scrollTop: vp.scrollTop,
      scrollHeight: vp.scrollHeight,
      publishedGeneration: publishedTranscriptGenerationRef.current,
    };
    loadEarlierRef.current();
  }, [historyNavigationControllerRef, historyScrollAnchorRef]);

  useLayoutEffect(() => {
    const vp = viewportRef.current;
    const below = belowViewportRef.current;
    const content = messagesContentRef.current;
    if (!vp || !below) return;
    userScrollInputRef.current = false;
    autoPagingEligibleAtRef.current = performance.now() + HISTORY_AUTOPAGING_SETTLE_MS;
    lastSampledScrollTopRef.current = vp.scrollTop;
    // On coarse pointers the browser fires "scroll" for programmatic and
    // resize-driven scrolls too, so the stick intent is only re-sampled during
    // a real touch/wheel gesture there.
    let gestureActive = false;
    let gestureClearTimer = 0;
    let delayedStartPin = 0;
    const scheduleGestureClear = () => {
      if (gestureClearTimer) window.clearTimeout(gestureClearTimer);
      gestureClearTimer = window.setTimeout(() => {
        gestureActive = false;
      }, 250);
    };
    const markGesture = () => {
      jumpToBottomUntilRef.current = 0;
      if (delayedStartPin) {
        window.clearTimeout(delayedStartPin);
        delayedStartPin = 0;
      }
      gestureActive = true;
      userScrollInputRef.current = true;
      scheduleGestureClear();
    };
    const markWheelGesture = (event: WheelEvent) => {
      markGesture();
      if (event.deltaY < 0) {
        wasAtBottomRef.current = false;
        setAtBottom(false);
      }
    };
    const sample = (force = false) => {
      const historyNavigation = historyNavigationControllerRef.current;
      if (historyNavigation.restoringScroll) return;
      if (performance.now() < jumpToBottomUntilRef.current) {
        vp.scrollTop = vp.scrollHeight;
        wasAtBottomRef.current = true;
        setAtBottom(true);
        return;
      }
      const previousScrollTop = lastSampledScrollTopRef.current;
      const movingTowardTop = previousScrollTop !== null && vp.scrollTop < previousScrollTop;
      lastSampledScrollTopRef.current = vp.scrollTop;
      if (force || !isCoarse || gestureActive) {
        const pinned = isPinnedToBottom(vp.scrollTop, vp.clientHeight, vp.scrollHeight);
        const prevStuck = wasAtBottomRef.current;
        wasAtBottomRef.current = pinned;
        if (pinned) lastAtBottomAtRef.current = performance.now();
        setAtBottom((prev) => (prev === pinned ? prev : pinned));
        // Gated on the restore having run: the forced mount sample reads a tall
        // transcript at scrollTop 0 as unpinned and would clobber the saved intent.
        if (pinned !== prevStuck && didRestoreScrollRef.current) {
          saveScrollState(sessionId, { stuck: pinned, top: vp.scrollTop });
        }
        // Momentum scrolling fires with no fresh touchmove; keep the gesture alive.
        if (gestureActive) scheduleGestureClear();
      }
      const decision = autoLoadDecision({
        scrollTop: vp.scrollTop,
        clientHeight: vp.clientHeight,
        scrollHeight: vp.scrollHeight,
        armed: historyNavigation.autoLoadArmed,
        canLoadEarlier: canLoadEarlierRef.current,
        hasScrolled: !force && userScrollInputRef.current && performance.now() >= autoPagingEligibleAtRef.current,
        movingTowardTop,
        now: performance.now(),
        lastLoadAt: historyNavigation.lastLoadAt,
      });
      historyNavigation.autoLoadArmed = decision.armed;
      if (decision.fire) {
        userScrollInputRef.current = false;
        requestEarlierHistory();
      }
    };
    const onScroll = () => sample();
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        userScrollInputRef.current = true;
      }
    };
    sample(true);
    vp.addEventListener("scroll", onScroll, { passive: true });
    vp.addEventListener("wheel", markWheelGesture, { passive: true });
    vp.addEventListener("pointerdown", markGesture, { passive: true });
    vp.addEventListener("touchstart", markGesture, { passive: true });
    vp.addEventListener("touchmove", markGesture, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    // Pin on every visualViewport resize frame so the transcript tracks the
    // soft keyboard animation in lockstep.
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const onVvResize = () => {
      if (wasAtBottomRef.current) vp.scrollTop = vp.scrollHeight;
    };
    vv?.addEventListener("resize", onVvResize);

    if (!didRestoreScrollRef.current) {
      didRestoreScrollRef.current = true;
      const historyAnchor = historyScrollAnchorRef.current;
      const saved = loadScrollState(sessionId);
      const stick = historyAnchor ? false : !saved || saved.stuck;
      wasAtBottomRef.current = stick;
      if (stick) lastAtBottomAtRef.current = performance.now();
      setAtBottom(stick);
      // Later passes catch content that lays out after paint; each rechecks the
      // current stick intent so an intervening user scroll wins.
      const applyStart = () => {
        if (historyAnchor) return;
        const top = restoredScrollTop(saved, wasAtBottomRef.current, vp.scrollHeight, vp.clientHeight);
        if (top != null) vp.scrollTop = top;
      };
      applyStart();
      requestAnimationFrame(() => requestAnimationFrame(applyStart));
      if (stick) delayedStartPin = window.setTimeout(applyStart, 150);
    }

    const saveScroll = () => {
      saveScrollState(sessionId, { stuck: wasAtBottomRef.current, top: vp.scrollTop });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveScroll();
    };
    window.addEventListener("pagehide", saveScroll);
    document.addEventListener("visibilitychange", onVisibility);
    // The viewport itself is observed too: chrome outside this view (the App
    // header collapse) can resize it.
    const wasAtBottom = () => wasAtBottomRef.current;
    const repin = () => {
      vp.scrollTop = vp.scrollHeight;
    };
    const ro = repinOnResize({ target: below, readHeight: () => below.offsetHeight, wasAtBottom, repin });
    const vpRo = repinOnResize({ target: vp, readHeight: () => vp.clientHeight, wasAtBottom, repin });
    // History navigation remounts the viewport and restores via the explicit
    // anchor below. Ordinary content growth follows only while pinned.
    const contentRo = new ResizeObserver(() => {
      if (wasAtBottomRef.current) {
        vp.scrollTop = vp.scrollHeight;
      }
    });
    if (content) contentRo.observe(content);
    return () => {
      ro.disconnect();
      vpRo.disconnect();
      contentRo.disconnect();
      vp.removeEventListener("scroll", onScroll);
      vp.removeEventListener("wheel", markWheelGesture);
      vp.removeEventListener("pointerdown", markGesture);
      vp.removeEventListener("touchstart", markGesture);
      vp.removeEventListener("touchmove", markGesture);
      window.removeEventListener("keydown", onKeyDown);
      vv?.removeEventListener("resize", onVvResize);
      window.removeEventListener("pagehide", saveScroll);
      document.removeEventListener("visibilitychange", onVisibility);
      saveScroll();
      if (gestureClearTimer) window.clearTimeout(gestureClearTimer);
      if (delayedStartPin) window.clearTimeout(delayedStartPin);
    };
  }, [historyNavigationControllerRef, historyScrollAnchorRef, requestEarlierHistory, isCoarse, sessionId]);

  useLayoutEffect(() => {
    const anchor = historyScrollAnchorRef.current;
    if (!anchor || publishedTranscriptGeneration <= anchor.publishedGeneration) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const controller = historyNavigationControllerRef.current;
    controller.restoringScroll = true;
    const restore = () => {
      vp.scrollTop = restoreEarlierHistoryScrollTop(anchor.scrollTop, anchor.scrollHeight, vp.scrollHeight);
    };
    restore();
    wasAtBottomRef.current = false;
    setAtBottom(false);
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      restore();
      secondFrame = requestAnimationFrame(restore);
    });
    const settleTimer = window.setTimeout(() => {
      restore();
      if (historyScrollAnchorRef.current === anchor) historyScrollAnchorRef.current = null;
      controller.restoringScroll = false;
    }, 200);
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      window.clearTimeout(settleTimer);
    };
  }, [historyNavigationControllerRef, historyScrollAnchorRef, publishedTranscriptGeneration]);

  // Hold the bottom pin through a keyboard or composer-collapse transition.
  // `wasAtBottomRef` covers sitting idle at the bottom; the timestamp covers an
  // interim resize-scroll that already cleared the ref.
  const chromeTransitionInitRef = useRef(true);
  useEffect(() => {
    if (chromeTransitionInitRef.current) {
      chromeTransitionInitRef.current = false;
      return;
    }
    const vp = viewportRef.current;
    if (!vp) return;
    const recentlyAtBottom = performance.now() - lastAtBottomAtRef.current < 1200;
    if (!wasAtBottomRef.current && !recentlyAtBottom) return;
    let raf = 0;
    const start = performance.now();
    const pin = () => {
      vp.scrollTop = vp.scrollHeight;
      if (performance.now() - start < 500) raf = requestAnimationFrame(pin);
    };
    raf = requestAnimationFrame(pin);
    return () => cancelAnimationFrame(raf);
  }, [keyboardOpen, composerCollapsed]);

  return {
    viewportRef,
    belowViewportRef,
    messagesContentRef,
    atBottom,
    isCoarse,
    scrollToBottom,
    requestEarlierHistory,
  };
}
