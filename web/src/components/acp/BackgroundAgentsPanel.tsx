// The Background pane: the session's sub-agents and background tasks
// (workflows, shells, monitors), read from the store fed by StructuredView's
// existing WebSocket, so it opens no connection of its own.

import { useEffect, useState } from "react";
import {
  Bot,
  ChevronDown,
  Eye,
  Layers,
  LocateFixed,
  Maximize2,
  Square,
  SquareTerminal,
  Workflow,
  X,
} from "lucide-react";

import { useBackgroundWork } from "../../hooks/useBackgroundWork";
import { useNow } from "../../hooks/useNow";
import { requestAgentView } from "../../hooks/useAgentView";
import { requestCardFocus } from "../../hooks/useCardFocus";
import type { BackgroundAgent, BackgroundAgentStatus, BackgroundAgentTool } from "../../lib/acpTypes";
import { backgroundAge, QUIET_AFTER_MS, type BackgroundItem, type BackgroundKind } from "../../lib/backgroundWork";
import { formatTokens } from "../../lib/turnUsage";

export function BackgroundAgentsPanel({
  sessionId,
  onShowInTranscript,
}: {
  sessionId: string | null;
  /** Reveal the transcript first, where it shares the screen with this pane (mobile). */
  onShowInTranscript?: () => void;
}) {
  const items = useBackgroundWork(sessionId);
  const running = items.filter((i) => i.state === "running");
  const now = useNow(15_000, running.length > 0);
  const idle = items.filter((i) => i.state === "idle");
  const finished = items.filter((i) => i.state !== "running" && i.state !== "idle");
  // History folds away while something is live; with nothing running it is the content.
  const [showFinished, setShowFinished] = useState<boolean | null>(null);
  const finishedOpen = showFinished ?? running.length === 0;

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs text-text-dim">
        Nothing in the background yet. Sub-agents, workflows, and background shells show up here while they run.
      </div>
    );
  }
  // ACP has no per-agent cancel, so a running sub-agent only stops with the turn.
  const interruptible = running.some((i) => i.agent?.status === "running");
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {running.length > 0 && (
        <>
          <GroupHeader label={`Running · ${running.length}`}>
            {interruptible && sessionId && <StopButton sessionId={sessionId} />}
          </GroupHeader>
          {running.map((item) => (
            <ItemRow
              key={item.key}
              item={item}
              sessionId={sessionId}
              onShowInTranscript={onShowInTranscript}
              now={now}
            />
          ))}
        </>
      )}
      {idle.length > 0 && (
        <>
          <GroupHeader label={`Idle · ${idle.length}`} />
          {idle.map((item) => (
            <ItemRow key={item.key} item={item} sessionId={sessionId} onShowInTranscript={onShowInTranscript} />
          ))}
        </>
      )}
      {finished.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={finishedOpen}
            onClick={() => setShowFinished(!finishedOpen)}
            className="flex items-center gap-1 border-b border-surface-700 px-3 py-1.5 text-left text-[11px] uppercase tracking-wider text-text-dim hover:text-text-secondary"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${finishedOpen ? "" : "-rotate-90"}`} aria-hidden />
            Finished · {finished.length}
          </button>
          {finishedOpen &&
            finished.map((item) => (
              <ItemRow key={item.key} item={item} sessionId={sessionId} onShowInTranscript={onShowInTranscript} />
            ))}
        </>
      )}
    </div>
  );
}

function GroupHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-surface-700 px-3 py-1.5">
      <span className="flex-1 text-[11px] uppercase tracking-wider text-text-dim">{label}</span>
      {children}
    </div>
  );
}

const KIND_ICONS: Record<BackgroundKind, typeof Layers> = {
  subagent: Bot,
  workflow: Workflow,
  shell: SquareTerminal,
  monitor: Eye,
  task: Layers,
};

const STATE_DOTS: Record<BackgroundItem["state"], string> = {
  running: "animate-pulse bg-status-waiting",
  idle: "border border-status-running",
  done: "bg-status-running",
  failed: "bg-status-error",
  stopped: "bg-text-dim/60",
};

function counts(item: BackgroundItem): string | null {
  const parts = [
    item.toolCount ? `${item.toolCount} ${item.toolCount === 1 ? "tool" : "tools"}` : null,
    item.tokens ? `${formatTokens(item.tokens)} tokens` : null,
  ];
  return parts.filter(Boolean).join(" · ") || null;
}

function ItemRow({
  item,
  sessionId,
  onShowInTranscript,
  now,
}: {
  item: BackgroundItem;
  sessionId: string | null;
  onShowInTranscript?: () => void;
  /** Set for running items, to show how long since each last did anything. */
  now?: number;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const Icon = KIND_ICONS[item.kind];
  const running = item.state === "running";
  const usage = counts(item);
  const label = item.stateLabel || (running ? item.kind : item.state);
  const lastActive = running && now !== undefined && item.lastActiveAt ? backgroundAge(item, now) : null;
  const quiet = lastActive !== null && now! - Date.parse(item.lastActiveAt!) >= QUIET_AFTER_MS;
  return (
    <div data-testid="background-item" className="border-b border-surface-800">
      <div className="flex items-center hover:bg-surface-800">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOTS[item.state]}`} />
          <Icon className="h-3.5 w-3.5 shrink-0 text-text-dim" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{item.name}</span>
          <Elapsed startedAt={item.startedAt} endedAt={item.endedAt} active={running} />
          <span className={`shrink-0 text-[11px] ${item.state === "failed" ? "text-status-error" : "text-text-dim"}`}>
            {label}
          </span>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-text-dim transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {item.stopTaskId && sessionId && <StopTaskButton sessionId={sessionId} taskId={item.stopTaskId} />}
        {item.viewAgentId && (
          <button
            type="button"
            onClick={() => {
              onShowInTranscript?.();
              requestAgentView(item.viewAgentId);
            }}
            title="View agent"
            aria-label="View agent"
            className="shrink-0 px-2 py-2 text-text-dim hover:text-text-secondary"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
        )}
        {item.cardId && (
          <button
            type="button"
            onClick={() => {
              onShowInTranscript?.();
              requestCardFocus(item.cardId!);
            }}
            title="Show in transcript"
            aria-label="Show in transcript"
            className="shrink-0 px-2 py-2 text-text-dim hover:text-text-secondary"
          >
            <LocateFixed className="h-3.5 w-3.5" />
          </button>
        )}
        {item.agent && (
          <button
            type="button"
            onClick={() => setModal(true)}
            title="Open full details"
            aria-label="Open full details"
            className="shrink-0 px-2 py-2 text-text-dim hover:text-text-secondary"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {!open && (item.activity || usage || lastActive) && (
        <div className="flex gap-2 px-3 pb-1.5 pl-[2.375rem] text-[11px] text-text-dim">
          {item.activity && <span className="min-w-0 flex-1 truncate">{item.activity}</span>}
          {usage && <span className="ml-auto shrink-0 tabular-nums">{usage}</span>}
          {lastActive && (
            <span
              data-testid="background-item-last-active"
              className={`ml-auto shrink-0 tabular-nums ${quiet ? "text-status-warning" : ""}`}
            >
              {lastActive}
            </span>
          )}
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-surface-800 bg-surface-900/30 px-3 py-2 pl-[2.375rem] text-[11px]">
          {usage && <Field label="usage" value={usage} />}
          {item.agent ? <AgentFields agent={item.agent} clamp /> : <TaskFields item={item} />}
        </div>
      )}
      {modal && item.agent && <AgentDetailModal agent={item.agent} onClose={() => setModal(false)} />}
    </div>
  );
}

function TaskFields({ item }: { item: BackgroundItem }) {
  const task = item.task!;
  return (
    <>
      {task.description && task.description !== task.name && <Field label="task" value={task.description} clamp />}
      {task.activity && <Field label="latest" value={task.activity} />}
      {task.summary && <Field label="result" value={task.summary} clamp />}
    </>
  );
}

/** A native subagent reports no model; only a real one is worth a row. */
function AgentFields({ agent, clamp }: { agent: BackgroundAgent; clamp?: boolean }) {
  return (
    <>
      {agent.warning && <Field label="warning" value={agent.warning} tone="warn" />}
      {agent.model && <Field label="model" value={agent.model} mono />}
      {agent.tools.length > 0 && <ToolList tools={agent.tools} />}
      {agent.prompt && <Field label="task" value={agent.prompt} clamp={clamp} />}
      {agent.result && <Field label="result" value={agent.result} clamp={clamp} />}
    </>
  );
}

/** Stops this one task; the agent reports its new state. */
function StopTaskButton({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      aria-label="Stop task"
      title="Stop this task"
      onClick={async () => {
        setBusy(true);
        try {
          await fetch(
            `/api/sessions/${encodeURIComponent(sessionId)}/acp/async-tasks/${encodeURIComponent(taskId)}/stop`,
            { method: "POST" },
          );
        } catch {
          // The task keeps running; its row still offers Stop.
        } finally {
          setBusy(false);
        }
      }}
      className={[
        "inline-flex shrink-0 items-center rounded-md border border-surface-600 bg-surface-800 p-1",
        "text-text-secondary transition-colors hover:border-rose-700/60 hover:bg-rose-950/30 hover:text-rose-300",
        busy ? "opacity-50" : "",
      ].join(" ")}
    >
      <Square className="h-3 w-3 fill-current" strokeWidth={0} />
    </button>
  );
}

/** ACP has no per-agent cancel; cancelling the session stops its async sub-agents. */
function StopButton({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title="Interrupt the session and stop running sub-agents"
      onClick={async () => {
        setBusy(true);
        try {
          await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/cancel`, { method: "POST" });
        } catch {
          // best-effort; the tailer marks idle agents stalled regardless
        } finally {
          setBusy(false);
        }
      }}
      className={[
        "inline-flex items-center gap-1 rounded-md border border-surface-600 bg-surface-800 px-2 py-0.5",
        "text-[11px] text-text-secondary transition-colors",
        "hover:border-rose-700/60 hover:bg-rose-950/30 hover:text-rose-300",
        busy ? "opacity-50" : "",
      ].join(" ")}
    >
      <Square className="h-3 w-3 fill-current" strokeWidth={0} />
      Interrupt
    </button>
  );
}

/** Full-detail modal for one sub-agent: the prompt, result, and every
 *  tool call shown in full (the panel is narrow and clamps long text). */
function AgentDetailModal({ agent, onClose }: { agent: BackgroundAgent; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[85vh] w-[680px] max-w-[92vw] flex-col rounded-lg border border-surface-700/50 bg-surface-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-surface-700 px-4 py-3">
          <Bot className="h-4 w-4 shrink-0 text-text-dim" />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-bright">
            {agent.description || "Sub-agent"}
          </span>
          <StatusLabel status={agent.status} toolCount={agent.toolCount} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-text-muted hover:text-text-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
          <AgentFields agent={agent} />
        </div>
      </div>
    </div>
  );
}

function ToolList({ tools }: { tools: BackgroundAgentTool[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-text-dim">tools · {tools.length}</span>
      <div className="flex flex-col gap-0.5">
        {tools.map((t, i) => (
          <div key={i} className="flex items-start gap-1.5" title={t.title ? `${t.name} ${t.title}` : t.name}>
            <span className="mt-1">
              <ToolDot ok={t.ok} />
            </span>
            <span className="shrink-0 font-mono text-text-secondary">{t.name}</span>
            {t.title && <span className="min-w-0 break-all font-mono text-text-dim">{t.title}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolDot({ ok }: { ok?: boolean | null }) {
  const cls =
    ok === undefined || ok === null ? "bg-status-waiting animate-pulse" : ok ? "bg-status-running" : "bg-status-error";
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${cls}`} />;
}

function Field({
  label,
  value,
  mono,
  tone,
  clamp,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "warn";
  /** Clamp long text in the narrow panel; the details modal shows it in full. */
  clamp?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-text-dim">{label}</span>
      <span
        className={[
          "whitespace-pre-wrap break-words",
          clamp ? "line-clamp-4" : "",
          mono ? "font-mono" : "",
          tone === "warn" ? "text-status-error" : "text-text-secondary",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}

function StatusLabel({ status, toolCount }: { status: BackgroundAgentStatus; toolCount: number }) {
  if (status === "running") {
    return (
      <span className="shrink-0 text-[11px] text-text-dim">
        running{toolCount > 0 ? ` · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : ""}
      </span>
    );
  }
  const label =
    status === "completed" ? "done" : status === "stalled" ? "stalled" : status === "detached" ? "detached" : "error";
  const tone = status === "error" ? "text-status-error" : "text-text-dim";
  return <span className={`shrink-0 text-[11px] ${tone}`}>{label}</span>;
}

/** Live-ticking elapsed for running agents; fixed duration once ended. */
function Elapsed({ startedAt, endedAt, active }: { startedAt: string; endedAt: string | null; active: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || endedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, endedAt]);
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(end)) return null;
  return (
    <span className="shrink-0 text-[11px] tabular-nums text-text-dim">{formatElapsed(Math.max(0, end - start))}</span>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
