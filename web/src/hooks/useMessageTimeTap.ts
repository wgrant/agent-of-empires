import { useState } from "react";

import { useIsCoarsePointer } from "./useIsCoarsePointer";

/** Taps on controls, links, and code, or that end a text selection, are not requests for the time. */
const IGNORED_TAP_TARGETS = "a, button, input, textarea, select, summary, pre, [role='button']";

/** On touch devices, a tap on a message toggles its time. */
export function useMessageTimeTap() {
  const coarse = useIsCoarsePointer();
  const [shown, setShown] = useState(false);
  const onClick = (e: React.MouseEvent) => {
    if (!coarse) return;
    if ((e.target as Element).closest(IGNORED_TAP_TARGETS)) return;
    if (window.getSelection()?.toString()) return;
    setShown((v) => !v);
  };
  return { shown: coarse && shown, onClick };
}
