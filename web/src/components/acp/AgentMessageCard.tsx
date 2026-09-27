// A message addressed to a subagent: its task, or a teammate's message that
// woke it for another run.

import { MessageSquare } from "lucide-react";

import { parseAgentMessages } from "../../lib/agentView";
import { Markdown } from "./Markdown";

export function AgentMessageCard({ text, align = "end" }: { text: string; align?: "start" | "end" }) {
  return (
    <div className={`flex w-full flex-col gap-1 ${align === "end" ? "items-end" : "items-start"}`}>
      {parseAgentMessages(text).map((message, i) => (
        <div
          key={i}
          data-testid="agent-message"
          className="max-w-[80%] min-w-0 rounded-md border border-surface-700 bg-surface-800/50 px-3 py-1.5 text-sm"
        >
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-text-dim">
            <MessageSquare className="h-3 w-3" aria-hidden="true" />
            {message.from ? `From ${message.from}` : "Task"}
          </div>
          <div className="max-h-64 overflow-y-auto">
            <Markdown text={message.body} smooth={false} />
          </div>
        </div>
      ))}
    </div>
  );
}
