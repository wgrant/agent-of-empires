// Moves the structured view between the main agent's transcript and those of
// the subagents it delegated to. Shift+Up/Down cycles while focus is outside a
// text field, and Escape returns to the main agent.

import { useEffect, useRef } from "react";

import type { AgentRunState, AgentSummary } from "../../lib/agentView";

const DOTS: Record<AgentRunState, string> = {
  running: "bg-brand-400 animate-pulse",
  done: "bg-status-running",
  failed: "bg-status-error",
  stopped: "bg-text-dim",
};

const LABELS: Record<AgentRunState, string> = {
  running: "working",
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
  const order = [null, ...agents.map((a) => a.id)];
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

  return (
    <div
      role="tablist"
      aria-label="Agents"
      data-testid="agent-switcher"
      className="flex items-center gap-1 overflow-x-auto border-b border-surface-800 px-3 py-1 [scrollbar-width:none]"
    >
      {chip(null, "Lead", "The main agent (Esc)")}
      {agents.map((agent) =>
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
  );
}
