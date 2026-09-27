// A context primer prompt: the recap folded away, the request it carried visible.

import { ChevronDown, History } from "lucide-react";
import { useState } from "react";

import type { ContextPrimer } from "../../lib/contextPrimer";
import { Markdown } from "./Markdown";

function title(turnCount: number): string {
  if (turnCount === 0) return "Context restored from the earlier conversation";
  return `Context restored from ${turnCount} earlier turn${turnCount === 1 ? "" : "s"}`;
}

export function ContextPrimerCard({ primer }: { primer: ContextPrimer }) {
  const [open, setOpen] = useState(false);
  const expandable = primer.recap !== "";
  const Header = expandable ? "button" : "div";
  return (
    <>
      <div
        data-testid="context-primer-card"
        className="w-full max-w-3xl overflow-hidden rounded-md border border-surface-700 bg-surface-800/50 text-sm"
      >
        <Header
          type={expandable ? "button" : undefined}
          aria-expanded={expandable ? open : undefined}
          onClick={expandable ? () => setOpen((v) => !v) : undefined}
          className={[
            "flex w-full items-center gap-2 px-3 py-1.5 text-left",
            expandable ? "cursor-pointer hover:bg-surface-800" : "",
          ].join(" ")}
        >
          <History className="h-3.5 w-3.5 shrink-0 text-text-dim" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{title(primer.turnCount)}</span>
          {primer.truncated && <span className="shrink-0 text-[11px] text-text-dim">older turns omitted</span>}
          {expandable && (
            <ChevronDown
              className={["h-3.5 w-3.5 shrink-0 text-text-dim transition-transform", open ? "rotate-180" : ""].join(
                " ",
              )}
            />
          )}
        </Header>
        {open && (
          <div
            data-testid="context-primer-recap"
            className="max-h-96 overflow-y-auto border-t border-surface-800 bg-surface-900/30 px-3 py-2"
          >
            <Markdown text={primer.recap} smooth={false} />
          </div>
        )}
      </div>
      {primer.currentRequest && (
        <div className="max-w-[80%] min-w-0 rounded-2xl rounded-br-sm border border-surface-700 bg-surface-800/70 px-3 py-1.5 text-sm">
          <Markdown text={primer.currentRequest} smooth={false} breaks />
        </div>
      )}
    </>
  );
}
