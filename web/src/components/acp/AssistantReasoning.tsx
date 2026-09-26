// A reasoning part, shown per the thinking display setting.

import { useContext } from "react";

import { ThinkingDisplayContext } from "../../lib/thinkingDisplay";
import { Markdown } from "./Markdown";

export function AssistantReasoning({ text }: { text: string }) {
  const display = useContext(ThinkingDisplayContext);
  if (!text || display === "hidden") return null;
  // Keyed so switching the display re-applies its default open state.
  return (
    <details
      key={display}
      open={display === "expanded"}
      className="my-2 rounded-lg border border-surface-700 bg-surface-900/40 text-text-secondary"
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium hover:text-text-primary">
        Thinking trace
      </summary>
      <div className="max-h-80 overflow-y-auto border-t border-surface-700 px-3 py-2 text-xs leading-relaxed">
        <Markdown text={text} smooth={false} />
      </div>
    </details>
  );
}
