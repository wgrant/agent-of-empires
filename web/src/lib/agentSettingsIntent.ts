import { reconcileLaunchIntent, type AgentSettingsSnapshot, type LaunchSettingsIntent } from "./agentSettings";
import { safeGetItem, safeRemoveItem, safeSetItem } from "./safeStorage";

function key(sessionId: string, agent: string) {
  return `aoe:agent-settings-intent:${sessionId}:${agent}`;
}

export function readLaunchIntent(sessionId: string, agent: string): LaunchSettingsIntent {
  try {
    const stored = JSON.parse(safeGetItem(key(sessionId, agent)) ?? "{}");
    const intent: LaunchSettingsIntent = {};
    if (typeof stored?.yolo_mode === "boolean") intent.yolo_mode = stored.yolo_mode;
    if (
      stored?.auto_compaction &&
      (stored.auto_compaction.tokens === null ||
        (Number.isSafeInteger(stored.auto_compaction.tokens) && stored.auto_compaction.tokens > 0))
    ) {
      intent.auto_compaction = { tokens: stored.auto_compaction.tokens };
    }
    return intent;
  } catch {
    return {};
  }
}

export function storeLaunchIntent(sessionId: string, agent: string, intent: LaunchSettingsIntent): void {
  if (Object.keys(intent).length) safeSetItem(key(sessionId, agent), JSON.stringify(intent));
  else safeRemoveItem(key(sessionId, agent));
}

export function confirmedLaunchIntent(
  sessionId: string,
  snapshot: AgentSettingsSnapshot,
  previous = readLaunchIntent(sessionId, snapshot.agent),
): LaunchSettingsIntent {
  const intent = reconcileLaunchIntent(snapshot, previous);
  storeLaunchIntent(sessionId, snapshot.agent, intent);
  return intent;
}
