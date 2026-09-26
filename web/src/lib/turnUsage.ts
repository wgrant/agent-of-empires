// Tooltip text for the model and token counts behind the agent's latest turn.

import type { TokenCounts, TurnTokenUsage } from "./acpTypes";

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function describeCounts(counts: TokenCounts): string {
  return [
    `${formatTokens(counts.input)} input`,
    counts.cache_read ? `${formatTokens(counts.cache_read)} cache read` : null,
    counts.cache_write ? `${formatTokens(counts.cache_write)} cache write` : null,
    `${formatTokens(counts.output)} output`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** E.g. ["Latest reply by claude-opus-5-5", "Last turn: 12k input · 3.1k output"], plus a line per model when several ran. */
export function describeTurnUsage(model: string | null, usage: TurnTokenUsage | null): string[] {
  const lines = model ? [`Latest reply by ${model}`] : [];
  if (!usage) return lines;
  lines.push(`Last turn: ${describeCounts(usage)}`);
  const models = usage.by_model ?? [];
  if (models.length > 1) lines.push(...models.map((m) => `  ${m.model}: ${describeCounts(m)}`));
  return lines;
}
