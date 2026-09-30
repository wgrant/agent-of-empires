// A reasoning part, shown per the thinking display setting.

import { Brain } from "lucide-react";
import { useContext } from "react";

import { ThinkingDisplayContext } from "../../lib/thinkingDisplay";
import { Markdown } from "./Markdown";

const HEADING = /^\*\*(.+)\*\*$/;

/** Codex reasoning summaries arrive as `**Title**` lines, with or without prose under them. */
function splitSummary(text: string): { headings: string[]; hasBody: boolean } {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const headings = lines.flatMap((l) => HEADING.exec(l)?.[1] ?? []);
  return { headings, hasBody: headings.length < lines.length };
}

export function AssistantReasoning({ text }: { text: string }) {
  const display = useContext(ThinkingDisplayContext);
  if (!text || display === "hidden") return null;
  const { headings, hasBody } = splitSummary(text);
  // Titles alone say all there is; a box around them only adds noise.
  if (headings.length > 0 && !hasBody) {
    return (
      <ul data-testid="reasoning-summary" className="acp-reasoning my-1.5 space-y-0.5 px-3 text-text-muted">
        {headings.map((heading, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <Brain className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-text-dim" aria-hidden />
            <span className="min-w-0">{heading}</span>
          </li>
        ))}
      </ul>
    );
  }
  // Expanded, a trace reads inline: a scroll box or a disclosure only gets in the way.
  if (display === "expanded") {
    return (
      <div data-testid="reasoning-inline" className="acp-reasoning my-2 flex gap-2 px-3 text-text-muted">
        <Brain className="mt-[0.3em] h-3.5 w-3.5 shrink-0 text-text-dim" aria-hidden />
        <div className="min-w-0 flex-1 border-l border-surface-700 pl-3">
          <Markdown text={text} smooth={false} />
        </div>
      </div>
    );
  }
  return (
    <details className="my-2 rounded-lg border border-surface-700 bg-surface-900/40 text-text-secondary">
      <summary className="cursor-pointer select-none truncate px-3 py-2 text-xs font-medium hover:text-text-primary">
        {headings[0] ?? "Thinking trace"}
      </summary>
      <div className="max-h-80 overflow-y-auto border-t border-surface-700 px-3 py-2 text-xs leading-relaxed">
        <Markdown text={text} smooth={false} />
      </div>
    </details>
  );
}
