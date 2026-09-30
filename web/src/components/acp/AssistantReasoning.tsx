// A reasoning part, shown per the thinking display setting.

import { Brain, ChevronRight } from "lucide-react";
import { useContext } from "react";

import { ThinkingDisplayContext } from "../../lib/thinkingDisplay";
import { Markdown } from "./Markdown";

const HEADING = /^\*\*(.+)\*\*$/;

/** Codex reasoning summaries arrive as `**Title**` lines, with or without prose under them. */
function splitSummary(text: string): { headings: string[]; hasBody: boolean; body: string; preview: string } {
  const sourceLines = text.split("\n");
  const lines = sourceLines.map((line) => line.trim()).filter(Boolean);
  const headings = lines.flatMap((l) => HEADING.exec(l)?.[1] ?? []);
  const firstContentLine = sourceLines.findIndex((line) => line.trim());
  const hasLeadingHeading = firstContentLine >= 0 && HEADING.test(sourceLines[firstContentLine]?.trim() ?? "");
  const body = hasLeadingHeading
    ? sourceLines
        .slice(firstContentLine + 1)
        .join("\n")
        .trimStart()
    : text;
  return {
    headings,
    hasBody: headings.length < lines.length,
    body,
    preview: headings[0] ?? lines[0] ?? "Thinking trace",
  };
}

export function AssistantReasoning({ text }: { text: string }) {
  const display = useContext(ThinkingDisplayContext);
  if (!text || display === "hidden") return null;
  const { headings, hasBody, body, preview } = splitSummary(text);
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
    if (headings[0] && hasBody) {
      return (
        <div data-testid="reasoning-inline" className="acp-reasoning my-2 px-3 text-text-muted">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Brain className="h-3.5 w-3.5 shrink-0 text-text-dim" aria-hidden />
            <span className="min-w-0">{headings[0]}</span>
          </div>
          <div className="ml-[22px] mt-1 border-l border-surface-700 pl-3">
            <Markdown text={body} smooth={false} />
          </div>
        </div>
      );
    }
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
    <details className="group acp-reasoning my-1.5 px-3 text-text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs font-medium hover:text-text-primary">
        <Brain className="h-3.5 w-3.5 shrink-0 text-text-dim" aria-hidden />
        <span className="min-w-0 truncate">{preview}</span>
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <div className="ml-[22px] max-h-80 overflow-y-auto border-l border-surface-700 py-1 pl-3 text-xs leading-relaxed">
        <Markdown text={body} smooth={false} />
      </div>
    </details>
  );
}
