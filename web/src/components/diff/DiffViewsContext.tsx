// This browser's diff views for the active session, for the diff pane and the
// plugin pane rows that point it at a range.

import { createContext, useContext } from "react";

import type { DiffTarget, DiffView } from "../../lib/diffViews";

export interface DiffViewsApi {
  /** The session these views and the diff pane belong to. */
  sessionId: string;
  views: readonly DiffView[];
  clearView: (repo: string | undefined) => void;
  /** Show `target` in the diff pane. False when it names a repo the session lacks. */
  openTarget: (target: DiffTarget) => boolean;
  /** Whether the diff pane shows `target` now. */
  isShowing: (target: DiffTarget) => boolean;
}

export const DiffViewsContext = createContext<DiffViewsApi | null>(null);

/** Null outside a session, where nothing can show a range. */
export function useDiffViews(): DiffViewsApi | null {
  return useContext(DiffViewsContext);
}

/** The views of `sessionId`'s diff pane, or null when it is not the one showing. */
export function useSessionDiffViews(sessionId: string | undefined): DiffViewsApi | null {
  const api = useDiffViews();
  return api && sessionId && api.sessionId === sessionId ? api : null;
}
