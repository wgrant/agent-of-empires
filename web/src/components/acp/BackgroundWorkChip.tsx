// How much background work is still running, beside the composer, so a
// session waiting on it does not look idle. Opens the Background pane.

import { useAsyncTasks, useBackgroundAgents } from "../../hooks/useAcpSession";
import { backgroundItems } from "../../lib/backgroundWork";
import { useOpenBackgroundAgentsPane } from "./backgroundAgentsContext";

export function BackgroundWorkChip({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const running = backgroundItems(useBackgroundAgents(sessionId), useAsyncTasks(sessionId)).filter(
    (item) => item.state === "running",
  );
  const openPane = useOpenBackgroundAgentsPane();
  if (running.length === 0) return null;
  const label = `${running.length} in background`;
  const title = running.map((item) => (item.activity ? `${item.name}: ${item.activity}` : item.name)).join("\n");
  return (
    <button
      type="button"
      data-testid="composer-background-work"
      onClick={openPane}
      disabled={!openPane}
      title={title}
      aria-label={`${label}. Show the Background pane`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:cursor-default"
    >
      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-brand-400" aria-hidden />
      <span className="tabular-nums">{compact ? running.length : label}</span>
    </button>
  );
}
