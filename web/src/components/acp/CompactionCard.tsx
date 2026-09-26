// A compaction: its outcome and measurements, with the summary it kept folded away.

import { FoldVertical } from "lucide-react";

import type { Compaction } from "./activityMessages";
import { formatTokens } from "../../lib/turnUsage";
import { Markdown } from "./Markdown";
import { CardChrome, formatDurationMs, useToolCardExpansion, type Status } from "./ToolCardChrome";

const STATES: Record<string, { status: Status; title: string }> = {
  running: { status: "running", title: "Compacting context…" },
  completed: { status: "ok", title: "Context compacted" },
  failed: { status: "err", title: "Compaction failed" },
  cancelled: { status: "stopped", title: "Compaction cancelled" },
  interrupted: { status: "stopped", title: "Compaction interrupted" },
};

function tokenChange({ pre_tokens: pre, post_tokens: post }: Compaction): string | null {
  if (pre == null) return null;
  return post == null ? `from ${formatTokens(pre)} tokens` : `${formatTokens(pre)} → ${formatTokens(post)} tokens`;
}

export function CompactionCard({ compaction }: { compaction: Compaction }) {
  const { status, title } = STATES[compaction.state] ?? STATES.completed!;
  const [open, setOpen] = useToolCardExpansion(status);
  const tokens = tokenChange(compaction);
  const facts = [
    compaction.trigger === "automatic" ? "auto" : compaction.trigger,
    compaction.duration_ms != null ? formatDurationMs(compaction.duration_ms) : null,
  ].filter(Boolean);
  const summary = compaction.summary.trim();
  const expandable = summary !== "" || !!compaction.error;
  return (
    <CardChrome
      status={status}
      icon={<FoldVertical className="h-3.5 w-3.5" />}
      label="compaction"
      primary={
        <>
          <span>{title}</span>
          {tokens && <span className="ml-2 text-text-dim">· {tokens}</span>}
        </>
      }
      meta={facts.length > 0 && <span className="text-[11px] text-text-dim">{facts.join(" · ")}</span>}
      expanded={expandable && open}
      onToggle={expandable ? () => setOpen((v) => !v) : undefined}
      body={
        <div data-testid="compaction-body" className="border-t border-surface-800 bg-surface-900/30 px-3 py-2">
          {compaction.error && <p className="text-xs text-status-error">{compaction.error}</p>}
          {summary && (
            <>
              <p className="mb-1 text-[11px] uppercase tracking-wider text-text-dim">What the model kept</p>
              <div className="max-h-96 overflow-y-auto text-sm text-text-primary">
                <Markdown text={summary} />
              </div>
            </>
          )}
        </div>
      }
    />
  );
}
