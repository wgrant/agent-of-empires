// The composer's one-line status: agent, permission mode, model, and effort.

import type { AcpState } from "../../lib/acpTypes";

export interface ComposerStatusParts {
  agent: string;
  /** Mode plus yolo; the one part tinted by how much the agent may do unasked. */
  permission: string | null;
  model: string | null;
  effort: string | null;
}

/** A mode that already grants everything yolo does. */
const BYPASS_MODE = /bypass|full access/i;

function agentDisplayName(agent: string): string {
  const known: Record<string, string> = {
    claude: "Claude",
    "claude-code": "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    gemini: "Gemini",
  };
  return (
    known[agent] ??
    agent.replace(/(^|[-_ ])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
  );
}

function compactModeName(mode: string): string {
  const parenthesised = mode.match(/^Agent \((.+)\)$/i);
  if (!parenthesised) return mode;
  const inner = parenthesised[1]!;
  return inner.charAt(0).toUpperCase() + inner.slice(1);
}

export function composerStatusParts({
  agent,
  mode,
  yoloMode,
  configOptions,
}: {
  agent: string;
  mode?: string;
  yoloMode: boolean;
  configOptions: AcpState["configOptions"];
}): ComposerStatusParts {
  const currentLabel = (category: "model" | "thought_level") => {
    const option = configOptions.find((candidate) => candidate.category === category);
    return (
      option?.options.find((candidate) => candidate.value === option.current_value)?.name ??
      option?.current_value ??
      null
    );
  };
  const shortMode = mode ? compactModeName(mode) : null;
  const permission = yoloMode
    ? shortMode && !BYPASS_MODE.test(shortMode)
      ? `${shortMode} · Yolo`
      : "Yolo"
    : shortMode;
  return {
    agent: agentDisplayName(agent),
    permission,
    model: currentLabel("model"),
    effort: currentLabel("thought_level"),
  };
}

export function composerStatusText(parts: ComposerStatusParts): string {
  return [parts.agent, parts.permission, parts.model, parts.effort].filter(Boolean).join(" · ");
}
