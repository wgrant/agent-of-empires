// A native subagent session: its task, then its own messages, thinking, and tools.

import { Sparkles } from "lucide-react";

import type { NativeSubagent, NativeSubagentItem } from "./activityMessages";
import { AssistantReasoning } from "./AssistantReasoning";
import { Markdown } from "./Markdown";
import { CardChrome, HighlightedBlock, PlaceholderLine, useToolCardExpansion, type Status } from "./ToolCardChrome";
import { ToolCard } from "./ToolCards";

const STATE_STATUS: Record<string, Status> = {
  completed: "ok",
  failed: "err",
  cancelled: "stopped",
  disconnected: "stopped",
};

function subagentStatus(subagent: NativeSubagent): Status {
  if (subagent.state) return STATE_STATUS[subagent.state] ?? "stopped";
  return subagent.unresolved ? "stopped" : "running";
}

/** What the subagent is doing now: its latest tool, else the start of its latest text. */
function latestActivity(items: NativeSubagentItem[]): string | null {
  const last = items[items.length - 1];
  if (!last) return null;
  if (last.type === "tool") return last.start.tool?.name ?? null;
  if (last.type === "subagent") return last.subagent.name;
  return last.text.trim().split("\n")[0] || null;
}

function ItemView({ item }: { item: NativeSubagentItem }) {
  switch (item.type) {
    case "text":
      return (
        <div className="text-sm text-text-primary">
          <Markdown text={item.text} />
        </div>
      );
    case "reasoning":
      return <AssistantReasoning text={item.text} />;
    case "tool":
      return item.start.tool ? <ToolCard tool={item.start.tool} result={item.result} nested /> : null;
    case "subagent":
      return <NativeSubagentCard subagent={item.subagent} />;
  }
}

const itemKey = (item: NativeSubagentItem, index: number) =>
  item.type === "tool" ? item.start.id : item.type === "subagent" ? item.subagent.id : `${item.type}-${index}`;

export function NativeSubagentCard({ subagent }: { subagent: NativeSubagent }) {
  const status = subagentStatus(subagent);
  const [open, setOpen] = useToolCardExpansion(status);
  const tools = subagent.items.filter((item) => item.type === "tool").length;
  const latest = status === "running" ? latestActivity(subagent.items) : null;
  return (
    <CardChrome
      status={status}
      icon={<Sparkles className="h-3.5 w-3.5" />}
      label="subagent"
      startedAt={subagent.startedAt}
      endedAt={subagent.endedAt}
      primary={
        <>
          <span className="truncate">{subagent.name}</span>
          {tools > 0 && (
            <span className="ml-2 text-text-dim">
              · {tools} {tools === 1 ? "tool" : "tools"}
            </span>
          )}
        </>
      }
      meta={latest && <span className="max-w-[40%] truncate text-[11px] text-text-dim">{latest}</span>}
      expanded={open}
      onToggle={() => setOpen((v) => !v)}
      body={
        open && (
          <div
            data-testid="native-subagent-body"
            className="flex flex-col gap-1 border-t border-surface-800 bg-surface-900/30 px-3 py-2"
          >
            {subagent.task && <HighlightedBlock text={subagent.task} language="markdown" maxLines={6} />}
            {subagent.items.map((item, index) => (
              <ItemView key={itemKey(item, index)} item={item} />
            ))}
            {subagent.items.length === 0 && (
              <PlaceholderLine>{status === "running" ? "Starting…" : "(no output)"}</PlaceholderLine>
            )}
          </div>
        )
      }
    />
  );
}
