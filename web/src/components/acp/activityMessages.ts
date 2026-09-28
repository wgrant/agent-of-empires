// Converts the flat ActivityRow log into assistant-ui's message tree. Each user
// row opens a user message; agent rows collapse into one assistant message whose
// tool-call parts are completed in place and folded into subagent and run groups.
// ThreadMessages.tsx rebuilds ToolCalls from the `_aoe_*` keys smuggled into argsText.

import type { ThreadMessageLike } from "@assistant-ui/react";

import { hasTodoArrayArgsText, parseJsonObject } from "../../lib/acpArgs";
import { lastClearIndex } from "../../lib/acpHistoryWindow";
import type { ActivityRow, CompactionInfo, HookInfo, ToolCall, ToolOutputBlock } from "../../lib/acpTypes";
import { hookHeadline } from "../../lib/agentHooks";
import { parseReviewFindings } from "../../lib/reviewFindings";
import { type AgentProfile, DEFAULT_AGENT_PROFILE, isSubagentToolName } from "../../lib/agentProfiles";

/** Synthetic part for a subagent Task with its child tool calls. */
export const SUBAGENT_TASK_NAME = "_aoe_subagent_task";
/** Synthetic part for a folded run of tool calls. */
export const TOOL_GROUP_NAME = "_aoe_tool_group";
/** Synthetic part for a folded run of todo snapshots. */
export const TODO_GROUP_NAME = "_aoe_todo_group";
/** Synthetic part for a native subagent session and its own transcript. */
export const NATIVE_SUBAGENT_NAME = "_aoe_native_subagent";
/** Synthetic part for a compaction and the summary it kept. */
export const COMPACTION_NAME = "_aoe_compaction";
/** Synthetic part for a Claude Code hook's run. */
export const HOOK_NAME = "_aoe_hook";

/** What a hook card renders. */
export interface HookRun {
  hook: HookInfo;
  output: string;
}

/** What a compaction card renders. */
export interface Compaction extends CompactionInfo {
  summary: string;
  startedAt: string;
}

/** What a native subagent card renders, in its session's order. */
export type NativeSubagentItem =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; start: ActivityRow; result?: ActivityRow }
  | { type: "subagent"; subagent: NativeSubagent }
  /** A message that woke the agent for another run. */
  | { type: "message"; text: string };

export interface NativeSubagent {
  id: string;
  name: string;
  /** `workflow`, or absent for a native subagent session. */
  kind: string | null;
  activity: string | null;
  task: string;
  /** Terminal state, or `null` while it runs. */
  state: string | null;
  /** No terminal state arrived and nothing is running any more. */
  unresolved: boolean;
  /** Spawned by another subagent rather than the main agent. */
  nested: boolean;
  /** A teammate that waits for messages between runs. */
  persistent: boolean;
  startedAt: string;
  endedAt?: string;
  items: NativeSubagentItem[];
}

/** A subagent's own rows in order, recursing into the subagents it spawned. */
function nativeSubagent(
  header: ActivityRow,
  rowsByOwner: ReadonlyMap<string, ActivityRow[]>,
  visiblyBusy: boolean,
): NativeSubagent {
  const info = header.subagent!;
  const items: NativeSubagentItem[] = [];
  const tools = new Map<string, Extract<NativeSubagentItem, { type: "tool" }>>();
  const appendText = (type: "text" | "reasoning", text: string) => {
    const last = items[items.length - 1];
    if (last?.type === type) last.text += text;
    else if (text) items.push({ type, text });
  };
  for (const row of rowsByOwner.get(info.id) ?? []) {
    if (row.kind === "subagent" && row.subagent) {
      items.push({ type: "subagent", subagent: nativeSubagent(row, rowsByOwner, visiblyBusy) });
    } else if (row.kind === "subagent_woken") {
      items.push({ type: "message", text: row.text });
    } else if (row.kind === "tool_start" && row.tool) {
      const item = { type: "tool" as const, start: row };
      tools.set(row.tool.id, item);
      items.push(item);
    } else if (row.kind === "tool_complete" || row.kind === "tool_error" || row.kind === "tool_stopped") {
      const item = tools.get(row.toolCallId ?? "");
      if (item) item.result = row;
    } else if (row.kind === "thinking") {
      appendText("reasoning", row.text);
    } else if (row.kind === "message") {
      appendText("text", row.text);
    }
  }
  const state = info.state ?? null;
  return {
    id: info.id,
    name: info.name,
    kind: info.kind ?? null,
    activity: info.activity ?? null,
    task: header.text,
    state,
    // A workflow runs outside any turn, so only its own end state ends it.
    unresolved: state === null && !visiblyBusy && info.kind !== "workflow",
    nested: !!header.subagentId,
    persistent: info.persistent ?? false,
    startedAt: header.at,
    ...(info.ended_at ? { endedAt: info.ended_at } : {}),
    items,
  };
}

/** Two in a row stay inline; three or more fold. */
const TOOL_GROUP_MIN_RUN = 3;
const TOOL_GROUP_MAX_RUN = 10;

/** React key for the fold point: the last `/clear` id, "none" before one, "all" when unfolded. */
export function clearFoldGeneration(rows: readonly ActivityRow[], showClearedTurns: boolean): string {
  if (showClearedTurns) return "all";
  const i = lastClearIndex(rows);
  return i < 0 ? "none" : rows[i]!.id;
}

function parseDate(iso: string): Date | undefined {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

const quoteLines = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const NOTICE_ICONS: Record<string, string> = { error: "⛔", warning: "⚠️" };

/** Rows rendered as an assistant blockquote callout, by kind. */
const CALLOUTS: Partial<Record<ActivityRow["kind"], (text: string, row: ActivityRow) => string>> = {
  session_cleared: (text) => `> ⚠️ **Conversation cleared**; ${text.replace(/^Conversation cleared,?\s*/, "")}`,
  // `session/load` fallback after a restart: the model's window is empty.
  context_reset: (text) => `> ⚠️ **Conversation context reset**; ${text}`,
  summary: (text) => `> 📝 **Summary of conversation so far**\n>\n${quoteLines(text)}`,
  // An agent notice is its title, then an optional description.
  agent_notice: (text, row) => {
    const [title, ...description] = text.split("\n");
    const icon = NOTICE_ICONS[row.severity ?? ""] ?? "ℹ️";
    return `> ${icon} **${title}**${description.length > 0 ? `\n>\n${quoteLines(description.join("\n"))}` : ""}`;
  },
};

export function activityToThreadMessages(
  rows: readonly ActivityRow[],
  visiblyBusy: boolean,
  showClearedTurns = false,
  todosEnabled = true,
  profile: AgentProfile = DEFAULT_AGENT_PROFILE,
): ThreadMessageLike[] {
  // Turns before the last /clear are forgotten by the model, so they fold by default.
  const start = showClearedTurns ? -1 : lastClearIndex(rows);
  const effectiveRows = start >= 0 ? rows.slice(start) : rows;

  const messages: ThreadMessageLike[] = [];
  let currentAssistant: AssistantBuilder | null = null;
  const flushAssistant = () => {
    if (!currentAssistant) return;
    messages.push(currentAssistant.build(todosEnabled, profile));
    currentAssistant = null;
  };
  const pushUser = (
    row: ActivityRow,
    content: ThreadMessageLike["content"],
    extra: Partial<ThreadMessageLike> = {},
  ) => {
    flushAssistant();
    messages.push({ id: row.id, role: "user", content, ...extra, createdAt: parseDate(row.at) });
  };
  const withCustom = (key: string, value: unknown) => ({ metadata: value ? { custom: { [key]: value } } : undefined });
  // A native subagent's rows render inside its card, not the main flow.
  const rowsByOwner = new Map<string, ActivityRow[]>();
  for (const row of effectiveRows) {
    if (row.subagentId) rowsByOwner.set(row.subagentId, [...(rowsByOwner.get(row.subagentId) ?? []), row]);
  }

  for (const row of effectiveRows) {
    if (row.subagentId) continue;
    if (row.turnStart) flushAssistant();
    const callout = CALLOUTS[row.kind];
    if (callout) {
      flushAssistant();
      messages.push({
        id: `assistant-${row.id}`,
        role: "assistant",
        content: [{ type: "text", text: callout(row.text, row) }],
        createdAt: parseDate(row.at),
      });
      continue;
    }
    if (row.kind === "user_prompt") {
      // Images become image parts; other attachments show as a labelled line.
      const parts = [
        ...(row.text ? [{ type: "text" as const, text: row.text }] : []),
        ...(row.attachments ?? []).map((att) =>
          att.kind === "image"
            ? { type: "image" as const, image: att.url }
            : { type: "text" as const, text: `📎 ${att.name ?? att.kind} (${att.mimeType})` },
        ),
      ];
      pushUser(
        row,
        parts.length > 0 ? parts : [{ type: "text", text: "" }],
        withCustom("promptSendFailure", row.sendFailure),
      );
      continue;
    }
    // Structured payloads ride on metadata so the user card renders without parsing text.
    if (row.kind === "elicitation_answered") {
      pushUser(row, [{ type: "text", text: row.text }], withCustom("elicitationAnswers", row.elicitationAnswers));
      continue;
    }
    if (row.kind === "user_diff_comments") {
      pushUser(row, [{ type: "text", text: row.text }], withCustom("diffComments", row.diffComments));
      continue;
    }
    // Opens a run in an agent's own view: its task, or the message that woke it.
    if (row.kind === "subagent_woken") {
      pushUser(row, [{ type: "text", text: row.text }], withCustom("agentMessage", true));
      continue;
    }

    currentAssistant ??= new AssistantBuilder(row.id, row.at);
    if (row.kind === "subagent") {
      if (row.subagent) currentAssistant.appendSubagent(nativeSubagent(row, rowsByOwner, visiblyBusy));
    } else if (row.kind === "compacted") {
      currentAssistant.appendCompaction(row);
    } else if (row.kind === "hook") {
      if (row.hook && hookHeadline(row.hook, row.text)) currentAssistant.appendHook(row, row.hook);
    } else if (row.kind === "tool_start" && row.tool) {
      currentAssistant.appendToolCall(row.tool, row.outputTail, row.toolSummary);
    } else if (row.kind === "tool_complete" || row.kind === "tool_error" || row.kind === "tool_stopped") {
      currentAssistant.completeToolCall(
        row.toolCallId ?? row.id.replace(/^(done|stopped)-/, ""),
        row.kind === "tool_error",
        row.kind === "tool_stopped",
        row.text,
        row.at,
        row.asyncSubagent ?? false,
        row.output,
      );
    } else if (row.kind === "empty_output") {
      // A turn with no output (interactive-only slash commands) gets a muted note.
      currentAssistant.appendText(`_${row.text}_`);
    } else if (row.kind === "thinking") {
      currentAssistant.appendReasoning(row.text);
    } else {
      currentAssistant.appendText(row.text);
    }
  }
  flushAssistant();

  const last = messages[messages.length - 1];
  if (visiblyBusy && last?.role === "assistant") {
    messages[messages.length - 1] = { ...last, status: { type: "running" } };
  }
  return messages;
}

type ToolResult = {
  content: string;
  endedAt?: string;
  stopped?: boolean;
  async?: boolean;
  output?: ToolOutputBlock[];
};

// Loose part shape, cast at build time; the renderer parses argsText itself.
type DraftPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      argsText: string;
      result?: ToolResult;
      isError?: boolean;
    };
type ToolPart = Extract<DraftPart, { type: "tool-call" }>;

class AssistantBuilder {
  private id: string;
  private createdAt?: Date;
  private parts: DraftPart[] = [];

  constructor(id: string, createdAtIso: string) {
    this.id = `assistant-${id}`;
    this.createdAt = parseDate(createdAtIso);
  }

  /** The server folds each streamed reply into one row, so adjacent rows are separate replies. */
  appendText(text: string) {
    if (!text) return;
    const last = this.parts[this.parts.length - 1];
    if (last && last.type === "text") last.text += `\n\n${text}`;
    else this.parts.push({ type: "text", text });
  }

  appendReasoning(text: string) {
    if (!text) return;
    const last = this.parts[this.parts.length - 1];
    if (last?.type === "reasoning") last.text += `\n\n${text}`;
    else this.parts.push({ type: "reasoning", text });
  }

  /** assistant-ui parts carry no timestamps or titles, so they travel as namespaced args. */
  appendToolCall(tool: ToolCall, outputTail?: string, summary?: string) {
    const argsObj = parseJsonObject(tool.args_preview) ?? {};
    if (tool.name) argsObj._aoe_title = tool.name;
    if (tool.started_at) argsObj._aoe_started_at = tool.started_at;
    if (tool.parent_tool_call_id) argsObj._aoe_parent_tool_call_id = tool.parent_tool_call_id;
    // The wire name survives later retitles, so subagent launches stay recognisable.
    if (tool.raw_name) argsObj._aoe_raw_tool_name = tool.raw_name;
    if (tool.memory_recall) argsObj._aoe_memory_recall = tool.memory_recall;
    if (outputTail) argsObj._aoe_output_tail = outputTail;
    if (summary) argsObj._aoe_summary = summary;
    this.parts.push({
      type: "tool-call",
      toolCallId: tool.id,
      toolName: tool.kind || "other",
      argsText: JSON.stringify(argsObj),
    });
  }

  appendSubagent(subagent: NativeSubagent) {
    this.parts.push({
      type: "tool-call",
      toolCallId: `native-subagent-${subagent.id}`,
      toolName: NATIVE_SUBAGENT_NAME,
      argsText: JSON.stringify(subagent),
    });
  }

  appendHook(row: ActivityRow, hook: HookInfo) {
    const run: HookRun = { hook, output: row.text };
    this.parts.push({ type: "tool-call", toolCallId: row.id, toolName: HOOK_NAME, argsText: JSON.stringify(run) });
  }

  appendCompaction(row: ActivityRow) {
    const compaction: Compaction = { state: "completed", ...row.compaction, summary: row.text, startedAt: row.at };
    this.parts.push({
      type: "tool-call",
      toolCallId: row.id,
      toolName: COMPACTION_NAME,
      argsText: JSON.stringify(compaction),
    });
  }

  completeToolCall(
    toolCallId: string,
    isError: boolean,
    stopped: boolean,
    resultText: string,
    endedAt: string,
    async: boolean,
    output?: ToolOutputBlock[],
  ) {
    const part = this.parts.find((p): p is ToolPart => p.type === "tool-call" && p.toolCallId === toolCallId);
    if (!part) return;
    part.result = { content: resultText, endedAt, stopped: stopped || undefined, async: async || undefined, output };
    part.isError = isError || undefined;
  }

  build(todosEnabled: boolean, profile: AgentProfile = DEFAULT_AGENT_PROFILE): ThreadMessageLike {
    const grouped = collapseToolRuns(collapseSubagents(this.parts, profile), todosEnabled);
    return {
      id: this.id,
      role: "assistant",
      content: (grouped.length ? grouped : [{ type: "text", text: "" }]) as ThreadMessageLike["content"],
      createdAt: this.createdAt,
    };
  }
}

function argString(argsText: string, key: string): string | null {
  const v = parseJsonObject(argsText)?.[key];
  return typeof v === "string" && v !== "" ? v : null;
}

function isTodoWriteArgsText(argsText: string, todosEnabled: boolean): boolean {
  if (!todosEnabled) return false;
  const title = parseJsonObject(argsText)?._aoe_title;
  return (typeof title === "string" && title.startsWith("Update TODOs")) || hasTodoArrayArgsText(argsText);
}

/** The verbatim child payload group renderers rebuild cards from. */
const childPayload = (p: ToolPart) => ({
  toolCallId: p.toolCallId,
  toolName: p.toolName,
  argsText: p.argsText,
  result: p.result,
  isError: p.isError,
});

function subagentPart(parent: ToolPart, children: ToolPart[], async?: true): ToolPart {
  return {
    type: "tool-call",
    toolCallId: `subagent-${parent.toolCallId}`,
    toolName: SUBAGENT_TASK_NAME,
    argsText: JSON.stringify({ parent: childPayload(parent), children: children.map(childPayload), async }),
  };
}

/** Fold each subagent into one synthetic part: a parent with inline children
 *  (linked by `_aoe_parent_tool_call_id`), an async launch, or a profile-declared
 *  off-protocol subagent tool. Children whose parent is elsewhere stay put. */
function collapseSubagents(parts: DraftPart[], profile: AgentProfile): DraftPart[] {
  const toolParts = parts.filter((p): p is ToolPart => p.type === "tool-call");
  const presentIds = new Set(toolParts.map((p) => p.toolCallId));
  const childrenByParent = new Map<string, ToolPart[]>();
  for (const p of toolParts) {
    const parentId = argString(p.argsText, "_aoe_parent_tool_call_id");
    if (parentId && presentIds.has(parentId)) {
      childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), p]);
    }
  }
  const children = new Set([...childrenByParent.values()].flat());
  const out: DraftPart[] = [];
  for (const p of parts) {
    if (p.type !== "tool-call") {
      out.push(p);
    } else if (children.has(p)) {
      continue;
    } else if (p.result?.async) {
      out.push(subagentPart(p, [], true));
    } else if (childrenByParent.has(p.toolCallId)) {
      out.push(subagentPart(p, childrenByParent.get(p.toolCallId)!));
    } else if (isSubagentToolName(argString(p.argsText, "_aoe_raw_tool_name"), profile)) {
      out.push(subagentPart(p, []));
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Fold runs of 3+ consecutive tool calls between text into groups, splitting
 *  generic runs into chunks of at most TOOL_GROUP_MAX_RUN. Group ids anchor on
 *  each chunk's first child so a growing run keeps its cards and expand state. */
function collapseToolRuns(parts: DraftPart[], todosEnabled: boolean): DraftPart[] {
  const out: DraftPart[] = [];
  let run: ToolPart[] = [];
  const group = (toolName: string, prefix: string, children: ToolPart[]) =>
    out.push({
      type: "tool-call",
      toolCallId: `${prefix}-${children[0]!.toolCallId}`,
      toolName,
      argsText: JSON.stringify({ children: children.map(childPayload) }),
    });
  const flushRun = () => {
    const isTodo = (p: ToolPart) => isTodoWriteArgsText(p.argsText, todosEnabled);
    if (run.length >= TOOL_GROUP_MIN_RUN && run.every(isTodo)) {
      group(TODO_GROUP_NAME, "todogroup", run);
    } else if (
      run.length >= TOOL_GROUP_MIN_RUN &&
      // A todo update among real work, a subagent card, or review findings stay inline.
      !run.some(
        (p) =>
          isTodo(p) ||
          parseReviewFindings(parseJsonObject(p.argsText)) !== null ||
          p.toolName === SUBAGENT_TASK_NAME ||
          p.toolName === NATIVE_SUBAGENT_NAME ||
          p.toolName === COMPACTION_NAME,
      )
    ) {
      for (let i = 0; i < run.length; i += TOOL_GROUP_MAX_RUN) {
        const chunk = run.slice(i, i + TOOL_GROUP_MAX_RUN);
        if (chunk.length >= TOOL_GROUP_MIN_RUN) group(TOOL_GROUP_NAME, "group", chunk);
        else out.push(...chunk);
      }
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const part of parts) {
    // A hook worth showing separates the tool calls around it, like text.
    if (part.type === "tool-call" && part.toolName !== HOOK_NAME) {
      run.push(part);
    } else {
      flushRun();
      out.push(part);
    }
  }
  flushRun();
  return out;
}
