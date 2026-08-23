import type { ReactNode } from "react";

/** Compact transcript-tail status for work that is waiting rather than busy. */
export function ConversationNextStepNotice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-surface-700/70 bg-surface-850/70 px-3 py-2 text-xs text-text-secondary"
      role="status"
    >
      <span className="shrink-0 text-accent-500" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
