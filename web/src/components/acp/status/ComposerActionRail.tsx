import type { ReactNode } from "react";

/**
 * Shared home for durable input state: intervention first, then queued work,
 * then optional suggestions. Individual rows keep their own editing and
 * dismissal controls; this component owns their placement next to Composer.
 */
export function ComposerActionRail({ children }: { children: ReactNode }) {
  return (
    <div className="border-t border-surface-800/70" data-testid="composer-action-rail">
      {children}
    </div>
  );
}
