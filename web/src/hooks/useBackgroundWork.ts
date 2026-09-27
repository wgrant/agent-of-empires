// A session's subagents and background tasks as one list, with when each last did anything.

import { useMemo } from "react";

import { lastActivityByAgent } from "../lib/agentView";
import { backgroundItems, type BackgroundItem } from "../lib/backgroundWork";
import { useAsyncTasks, useBackgroundAgents, useSessionActivity } from "./useAcpSession";

export function useBackgroundWork(sessionId: string | null): BackgroundItem[] {
  const agents = useBackgroundAgents(sessionId);
  const tasks = useAsyncTasks(sessionId);
  const activity = useSessionActivity(sessionId);
  const lastActivity = useMemo(() => lastActivityByAgent(activity), [activity]);
  return useMemo(() => backgroundItems(agents, tasks, lastActivity), [agents, tasks, lastActivity]);
}
