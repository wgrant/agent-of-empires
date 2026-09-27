// Which agent's transcript the structured view shows: the main agent's, or
// one of the subagents it delegated to. Cards and panels outside the view
// switch it by event.

import { useCallback, useEffect, useRef, useState } from "react";

import { CARD_FOCUS_EVENT, requestCardFocus } from "./useCardFocus";

const VIEW_EVENT = "aoe:view-agent";

/** Show `agentId`'s own transcript, or the main agent's for `null`. */
export function requestAgentView(agentId: string | null): void {
  window.dispatchEvent(new CustomEvent<string | null>(VIEW_EVENT, { detail: agentId }));
}

export function useAgentView(sessionId: string) {
  const [view, setView] = useState<{ sessionId: string; agentId: string | null }>({ sessionId, agentId: null });
  const agentId = view.sessionId === sessionId ? view.agentId : null;
  const agentIdRef = useRef(agentId);
  useEffect(() => {
    agentIdRef.current = agentId;
  });
  useEffect(() => {
    const onView = (event: Event) => setView({ sessionId, agentId: (event as CustomEvent<string | null>).detail });
    // Cards live in the main agent's transcript: return there, then ask
    // again once its cards have mounted.
    const onCardFocus = (event: Event) => {
      if (agentIdRef.current === null) return;
      setView({ sessionId, agentId: null });
      const cardId = (event as CustomEvent<string>).detail;
      requestAnimationFrame(() => requestAnimationFrame(() => requestCardFocus(cardId)));
    };
    window.addEventListener(VIEW_EVENT, onView);
    window.addEventListener(CARD_FOCUS_EVENT, onCardFocus);
    return () => {
      window.removeEventListener(VIEW_EVENT, onView);
      window.removeEventListener(CARD_FOCUS_EVENT, onCardFocus);
    };
  }, [sessionId]);
  const select = useCallback((next: string | null) => setView({ sessionId, agentId: next }), [sessionId]);
  return [agentId, select] as const;
}
