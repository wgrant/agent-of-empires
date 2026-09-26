// Lets a panel outside the transcript open a card and bring it into view.

import { useEffect, useRef, useState } from "react";

const FOCUS_EVENT = "aoe:focus-transcript-card";
const FLASH_MS = 1200;

export function requestCardFocus(cardId: string): void {
  window.dispatchEvent(new CustomEvent<string>(FOCUS_EVENT, { detail: cardId }));
}

/** For the card `cardId`: `open` runs when a focus is requested, then the
 *  returned ref scrolls into view and `flash` marks it briefly. */
export function useCardFocus(cardId: string | undefined, open: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    if (!cardId) return;
    let timer: number | undefined;
    const onFocus = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== cardId) return;
      openRef.current();
      // After the open re-render, so the expanded card is what scrolls into view.
      requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }));
      setFlash(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFlash(false), FLASH_MS);
    };
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => {
      window.removeEventListener(FOCUS_EVENT, onFocus);
      window.clearTimeout(timer);
    };
  }, [cardId]);
  return { ref, flash };
}
