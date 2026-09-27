// Moves the structured view between the main agent's transcript and those of
// the subagents it delegated to. Shift+Up/Down cycles while focus is outside a
// text field, and Escape returns to the main agent.

import { useEffect, useRef, useState } from "react";

import { partitionAgents, type AgentRunState, type AgentSummary } from "../../lib/agentView";

const DOTS: Record<AgentRunState, string> = {
  running: "bg-brand-400 animate-pulse",
  idle: "border border-status-running",
  done: "bg-status-running",
  failed: "bg-status-error",
  stopped: "bg-text-dim",
};

const LABELS: Record<AgentRunState, string> = {
  running: "working",
  idle: "idle",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export function AgentSwitcher({
  agents,
  viewedAgentId,
  onView,
}: {
  agents: readonly AgentSummary[];
  viewedAgentId: string | null;
  onView: (agentId: string | null) => void;
}) {
  const { shown, earlier } = partitionAgents(agents, viewedAgentId);
  const order = [null, ...shown.map((a) => a.id)];
  const orderRef = useRef(order);
  const viewedRef = useRef(viewedAgentId);
  useEffect(() => {
    orderRef.current = order;
    viewedRef.current = viewedAgentId;
  });
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [viewedAgentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // The composer cannot send while an agent is shown, so Escape leaves from there too.
      if (e.key === "Escape" && viewedRef.current !== null) {
        e.preventDefault();
        onView(null);
        return;
      }
      if (isEditable(e.target)) return;
      if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const ids = orderRef.current;
      const i = ids.indexOf(viewedRef.current);
      const next = ids[(i + (e.key === "ArrowDown" ? 1 : ids.length - 1)) % ids.length]!;
      e.preventDefault();
      onView(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onView]);

  const chip = (id: string | null, children: React.ReactNode, title: string) => {
    const selected = id === viewedAgentId;
    return (
      <button
        key={id ?? "lead"}
        ref={selected ? selectedRef : undefined}
        type="button"
        role="tab"
        aria-selected={selected}
        title={title}
        onClick={() => onView(id)}
        className={[
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
          selected
            ? "bg-surface-700 text-text-primary"
            : "text-text-secondary hover:bg-surface-800 hover:text-text-primary",
        ].join(" ")}
      >
        {children}
      </button>
    );
  };

  // Single-pane layouts hang the header's collapse tab over the right edge.
  return (
    <div className="flex items-center border-b border-surface-800 pr-12 md:pr-3">
      <div
        role="tablist"
        aria-label="Agents"
        data-testid="agent-switcher"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1 pl-3 [scrollbar-width:none]"
      >
        {chip(null, "Lead", "The main agent (Esc)")}
        {shown.map((agent) =>
          chip(
            agent.id,
            <>
              <span className={`h-1.5 w-1.5 rounded-full ${DOTS[agent.state]}`} aria-hidden="true" />
              <span className="max-w-[12rem] truncate">{agent.name}</span>
              <span className="sr-only">, {LABELS[agent.state]}</span>
            </>,
            `${agent.name}: ${LABELS[agent.state]} (Shift+↑/↓ to switch)`,
          ),
        )}
      </div>
      {earlier.length > 0 && <EarlierAgents agents={earlier} onView={onView} />}
    </div>
  );
}

/** Finished agents from earlier turns, kept out of the tab row. */
function EarlierAgents({ agents, onView }: { agents: readonly AgentSummary[]; onView: (agentId: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0 pl-1">
      <button
        type="button"
        data-testid="agent-switcher-earlier"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${agents.length} finished agent${agents.length === 1 ? "" : "s"} from earlier turns`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center rounded-md px-2 text-xs tabular-nums text-text-dim transition-colors hover:bg-surface-800 hover:text-text-primary"
      >
        +{agents.length}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 max-h-72 min-w-[12rem] overflow-y-auto rounded-md border border-surface-700/50 bg-surface-800 py-1 shadow-xl"
        >
          {[...agents].reverse().map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onView(agent.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-700/60 hover:text-text-primary"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOTS[agent.state]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span className="text-text-dim">{LABELS[agent.state]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
