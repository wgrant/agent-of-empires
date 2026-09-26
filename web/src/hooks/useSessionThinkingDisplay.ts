import { useCallback, useSyncExternalStore } from "react";

import { safeGetItem, safeRemoveItem, safeSetItem } from "../lib/safeStorage";
import { parseThinkingDisplay, sessionThinkingDisplayKey, type ThinkingDisplay } from "../lib/thinkingDisplay";
import { useWebSettings } from "./useWebSettings";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** A session's thinking display: its own override when set, else the dashboard default. */
export function useSessionThinkingDisplay(sessionId: string) {
  const { settings } = useWebSettings();
  const override = useSyncExternalStore(subscribe, () =>
    parseThinkingDisplay(safeGetItem(sessionThinkingDisplayKey(sessionId))),
  );

  /** `null` drops the override so the session follows the default again. */
  const setOverride = useCallback(
    (value: ThinkingDisplay | null) => {
      const key = sessionThinkingDisplayKey(sessionId);
      if (value === null) safeRemoveItem(key);
      else safeSetItem(key, value);
      for (const listener of listeners) listener();
    },
    [sessionId],
  );

  return {
    effective: override ?? settings.thinkingDisplay,
    override,
    globalDefault: settings.thinkingDisplay,
    setOverride,
  };
}
