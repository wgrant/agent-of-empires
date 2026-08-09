export interface AgentLaunchOption {
  id: "yolo_mode";
  name: string;
  description: string;
  warning: string;
  enabled: boolean;
}

/** Launch-only controls that belong beside live ACP modes but require the
 * adapter process to be replaced. OpenCode exposes Build/Plan over ACP while
 * auto-approval is configured through OPENCODE_PERMISSION at process launch. */
export function agentLaunchOptions(agent: string | null, yoloMode: boolean): AgentLaunchOption[] {
  if (agent !== "opencode") return [];
  return [
    {
      id: "yolo_mode",
      name: "Yolo",
      description: "Allow all tool calls without approval prompts",
      warning: "OpenCode will be able to run commands and edit files without asking for approval.",
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

/** Persist launch-only options and ask the server to restart only this ACP
 * worker. The endpoint is a typed patch so more basic options can share the
 * lifecycle without adding one route per setting. */
export async function updateAgentLaunchOptions(sessionId: string, patch: { yolo_mode?: boolean }): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (response.ok) return;

  const body: unknown = await response.json().catch(() => null);
  throw new Error(errorMessage(body, response.status));
}
