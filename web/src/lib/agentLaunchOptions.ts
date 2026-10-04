import type { AgentSettingsPatch } from "./agentSettings";

export interface AgentLaunchOption {
  id: "yolo_mode";
  name: string;
  description: string;
  warning: string;
  enabled: boolean;
}

export function agentLaunchOptions(requiresRestart: boolean, yoloMode: boolean): AgentLaunchOption[] {
  if (!requiresRestart) return [];
  return [
    {
      id: "yolo_mode",
      name: "Yolo",
      description: "Allow all tool calls without approval prompts",
      warning: "The agent will be able to run commands and edit files without asking for approval.",
      enabled: yoloMode,
    },
  ];
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  return `Could not update agent launch options (HTTP ${status})`;
}

/** Save desired settings; restart only when explicitly requested. */
export async function updateAgentLaunchOptions(sessionId: string, patch: AgentSettingsPatch): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (response.ok) return;

  const body: unknown = await response.json().catch(() => null);
  throw new Error(errorMessage(body, response.status));
}
