// How much of the agent's thinking the conversation shows. Display-only: thinking is always
// recorded, so a later setting can reveal what an earlier one hid.

import { createContext } from "react";

export type ThinkingDisplay = "hidden" | "collapsed" | "expanded";

export const THINKING_DISPLAYS: readonly ThinkingDisplay[] = ["hidden", "collapsed", "expanded"];

export const DEFAULT_THINKING_DISPLAY: ThinkingDisplay = "collapsed";

export const THINKING_DISPLAY_LABELS: Record<ThinkingDisplay, string> = {
  hidden: "Hidden",
  collapsed: "Collapsed",
  expanded: "Expanded",
};

export function parseThinkingDisplay(value: unknown): ThinkingDisplay | null {
  return THINKING_DISPLAYS.includes(value as ThinkingDisplay) ? (value as ThinkingDisplay) : null;
}

/** Per-session overrides sync across browsers by this prefix; see `webUiSync`. */
export const SESSION_THINKING_DISPLAY_PREFIX = "aoe-session-thinking-display-";

export function sessionThinkingDisplayKey(sessionId: string): string {
  return `${SESSION_THINKING_DISPLAY_PREFIX}${sessionId}`;
}

/** The effective display for the conversation being rendered. */
export const ThinkingDisplayContext = createContext<ThinkingDisplay>(DEFAULT_THINKING_DISPLAY);
