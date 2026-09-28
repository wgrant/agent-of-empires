// Paced reveal of streaming text, from whatever was there when it mounted.
//
// assistant-ui's useSmooth starts a running part from "" on every mount and
// part change, so switching back to a session whose open turn ends in text
// retyped all of it. This reveals only what arrives after mount, at the same
// rate, and shows a replacement (text that does not extend what is shown) at
// once rather than retyping it.

import { useEffect, useRef, useState } from "react";

import { useMediaQuery } from "./useMediaQuery";

/** useSmooth's pacing: drain what is pending in about this long... */
const DRAIN_MS = 250;
/** ...but never slower than this per character. */
const MAX_CHAR_INTERVAL_MS = 5;

/** `text` as far as it has been revealed. With `active` false, or under
 *  reduced motion, it is all of `text` at once. */
export function useReveal(text: string, active: boolean): string {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const pacing = active && !reduceMotion;
  const [shown, setShown] = useState(text);

  // A replacement, or no pacing: show the text as it is, during render.
  const snap = !pacing || !text.startsWith(shown);
  if (snap && shown !== text) setShown(text);

  const frame = useRef<number | null>(null);
  useEffect(() => {
    if (snap || shown === text) return;
    let last = performance.now();
    let revealed = shown.length;
    const step = (now: number) => {
      const pending = text.length - revealed;
      const perChar = Math.min(MAX_CHAR_INTERVAL_MS, DRAIN_MS / pending);
      const chars = Math.min(pending, Math.floor((now - last) / perChar));
      if (chars > 0) {
        revealed += chars;
        last += chars * perChar;
        setShown(text.slice(0, revealed));
      }
      frame.current = revealed < text.length ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    // `shown` is where this run starts; its own updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, snap]);

  return snap ? text : shown;
}
