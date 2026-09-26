// How much background work a session has running, for the Background pane's toggle.

import { runningBackgroundCount } from "../lib/backgroundWork";
import { useAsyncTasks, useBackgroundAgents } from "./useAcpSession";

export function useRunningBackgroundCount(sessionId: string | null): number {
  return runningBackgroundCount(useBackgroundAgents(sessionId), useAsyncTasks(sessionId));
}
