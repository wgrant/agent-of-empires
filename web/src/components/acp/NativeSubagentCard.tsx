// A native subagent session or a workflow run: its task, then its own
// messages, thinking, and tools.

import { Sparkles, Workflow } from "lucide-react";

import type { NativeSubagent, NativeSubagentItem } from "./activityMessages";
import { requestAgentView } from "../../hooks/useAgentView";
import { useCardFocus } from "../../hooks/useCardFocus";
import { AgentMessageCard } from "./AgentMessageCard";
import { AssistantReasoning } from "./AssistantReasoning";
import { Markdown } from "./Markdown";
import { CardChrome, PlaceholderLine, useToolCardExpansion, type Status } from "./ToolCardChrome";
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
    case "message":
      return <AgentMessageCard text={item.text} align="start" />;
  }
}

const itemKey = (item: NativeSubagentItem, index: number) =>
  item.type === "tool" ? item.start.id : item.type === "subagent" ? item.subagent.id : `${item.type}-${index}`;

/** A skill that runs in its own context reports as a subagent named `/<skill>`. */
function cardLabel(subagent: NativeSubagent): "workflow" | "skill" | "subagent" {
  if (subagent.kind === "workflow") return "workflow";
  return subagent.name.startsWith("/") ? "skill" : "subagent";
}

export function NativeSubagentCard({ subagent }: { subagent: NativeSubagent }) {
  const status = subagentStatus(subagent);
  // A teammate between runs is waiting for a message, not finished.
  const idle = status === "ok" && subagent.persistent;
  const [open, setOpen] = useToolCardExpansion(status);
  const focus = useCardFocus(`native-subagent-${subagent.id}`, () => setOpen(true));
  const tools = subagent.items.filter((item) => item.type === "tool").length;
  const latest = status === "running" ? (subagent.activity ?? latestActivity(subagent.items)) : null;
  const label = cardLabel(subagent);
  const Icon = label === "workflow" ? Workflow : Sparkles;
  return (
    <CardChrome
      status={status}
      anchorRef={focus.ref}
      highlighted={focus.flash}
      icon={<Icon className="h-3.5 w-3.5" />}
      label={label}
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
      // A narrow card keeps its name; the Background pane still shows the activity.
      meta={
        idle ? (
          <span className="text-[11px] text-text-dim">idle</span>
        ) : (
          latest && <span className="hidden max-w-[40%] truncate text-[11px] text-text-dim sm:inline">{latest}</span>
        )
      }
      neutralOnDone={idle}
      expanded={open}
      onToggle={() => setOpen((v) => !v)}
      body={
        open && (
          <div
            data-testid="native-subagent-body"
            className="flex flex-col gap-1 border-t border-surface-800 bg-surface-900/30 px-3 py-2"
          >
            {!subagent.nested && (
              <button
                type="button"
                onClick={() => requestAgentView(subagent.id)}
                className="self-end text-[11px] text-text-dim hover:text-text-secondary"
              >
                Open agent view
              </button>
            )}
            {subagent.task && label === "skill" ? (
              // The skill's own recipe, not a task the agent wrote.
              <details className="text-xs text-text-dim">
                <summary className="cursor-pointer select-none hover:text-text-secondary">Skill instructions</summary>
                <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-surface-800 bg-surface-900/60 px-2 py-1 text-text-secondary">
                  {subagent.task}
                </p>
              </details>
            ) : (
              subagent.task && (
                <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded border border-surface-800 bg-surface-900/60 px-2 py-1 text-xs text-text-secondary">
                  {subagent.task}
                </p>
              )
            )}
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
