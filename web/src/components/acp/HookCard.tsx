// A Claude Code hook's run: live while it runs, then its outcome and output.

import { Webhook } from "lucide-react";

import type { HookInfo } from "../../lib/acpTypes";
import { hookHeadline } from "../../lib/agentHooks";
import { CardChrome, useToolCardExpansion, type Status } from "./ToolCardChrome";

const STATUS: Record<string, Status> = { running: "running", success: "ok", cancelled: "stopped" };

export function HookCard({ hook, output }: { hook: HookInfo; output: string }) {
  const status = STATUS[hook.status] ?? "err";
  const [open, setOpen] = useToolCardExpansion(status);
  const headline = hookHeadline(hook, output);
  if (!headline) return null;
  const expandable = output.trim().includes("\n");
  return (
    <CardChrome
      status={status}
      icon={<Webhook className="h-3.5 w-3.5" />}
      label="hook"
      primary={<span>{headline}</span>}
      expanded={expandable && open}
      onToggle={expandable ? () => setOpen((v) => !v) : undefined}
      body={
        <pre className="max-h-64 overflow-auto border-t border-surface-800 bg-surface-900/30 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
          {output.trim()}
        </pre>
      }
    />
  );
}
