// How much background work is still running, beside the composer, so a
// session waiting on it does not look idle. Warns when all of it has gone
// quiet, and opens the Background pane.

import { useBackgroundWork } from "../../hooks/useBackgroundWork";
import { useNow } from "../../hooks/useNow";
import { backgroundAge, lastBackgroundActivity, QUIET_AFTER_MS } from "../../lib/backgroundWork";
import { formatDurationSecondsShort } from "../sidebar/format";
import { useOpenBackgroundAgentsPane } from "./backgroundAgentsContext";

export function BackgroundWorkChip({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const running = useBackgroundWork(sessionId).filter((item) => item.state === "running");
  const now = useNow(15_000, running.length > 0);
  const openPane = useOpenBackgroundAgentsPane();
  if (running.length === 0) return null;
  const lastActive = lastBackgroundActivity(running);
  const quietMs = lastActive === null ? 0 : now - lastActive;
  const quiet = quietMs >= QUIET_AFTER_MS ? formatDurationSecondsShort(Math.floor(quietMs / 1000)) : null;
  const label = `${running.length} in background${quiet ? ` · quiet ${quiet}` : ""}`;
  const title = running
    .map((item) => `${item.name}${item.activity ? `: ${item.activity}` : ""} · ${backgroundAge(item, now)}`)
    .join("\n");
  return (
    <button
      type="button"
      data-testid="composer-background-work"
      data-quiet={quiet ? "" : undefined}
      onClick={openPane}
      disabled={!openPane}
      title={quiet ? `Nothing has reported progress for ${quiet}.\n${title}` : title}
      aria-label={`${label}. Show the Background pane`}
      className={[
        "inline-flex shrink-0 items-center gap-1.5 rounded-md text-[11px] transition-colors disabled:cursor-default",
        quiet ? "text-status-warning hover:text-status-warning" : "text-text-secondary hover:text-text-primary",
      ].join(" ")}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${quiet ? "bg-status-warning" : "animate-pulse bg-brand-400"}`}
        aria-hidden
      />
      <span className="tabular-nums">{compact ? (quiet ? `${running.length}!` : running.length) : label}</span>
    </button>
  );
}
