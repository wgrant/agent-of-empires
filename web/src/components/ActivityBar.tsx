import type { PaneDisplay } from "./Dock";
import { PaneIcon } from "./PaneIcon";

interface Props {
  paneIds: string[];
  descriptorFor: (id: string) => PaneDisplay;
  isOpen: (id: string) => boolean;
  onToggle: (id: string) => void;
  /** Running work per pane id, shown as a count on its icon. */
  badges?: Readonly<Record<string, number>>;
}

/** Desktop icon strip (JetBrains-style tool-window bar): one icon per dockable pane (built-in or plugin-
 *  contributed), clicking toggles that pane open or closed. */
export function ActivityBar({ paneIds, descriptorFor, isOpen, onToggle, badges = {} }: Props) {
  if (paneIds.length === 0) return null;
  return (
    <div className="hidden md:flex items-center gap-0.5" data-testid="activity-bar">
      {paneIds.map((id) => {
        const desc = descriptorFor(id);
        const open = isOpen(id);
        const name = desc.title.toLowerCase();
        const count = badges[id] ?? 0;
        return (
          <button
            key={id}
            onClick={() => onToggle(id)}
            aria-pressed={open}
            data-testid={`pane-toggle-${id}`}
            className={`relative w-8 h-8 flex items-center justify-center cursor-pointer rounded-md transition-colors hover:bg-surface-700/50 ${
              open ? "text-text-primary bg-surface-700/40" : "text-text-dim hover:text-text-secondary"
            }`}
            title={`${open ? "Hide" : "Show"} ${name} pane`}
            aria-label={count > 0 ? `Toggle ${name} pane, ${count} running` : `Toggle ${name} pane`}
          >
            <PaneIcon icon={desc.icon} iconAssetUrl={desc.iconAssetUrl} className="size-4" />
            {count > 0 && <RunningBadge count={count} testId={`pane-badge-${id}`} />}
          </button>
        );
      })}
    </div>
  );
}

/** A count pinned to a toggle's corner: work running in the pane it opens. */
export function RunningBadge({ count, testId }: { count: number; testId: string }) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className="absolute -top-1 -right-1 min-w-[1rem] rounded-full bg-surface-600 px-1 text-center text-[10px] font-semibold leading-4 tabular-nums text-text-primary"
    >
      {count}
    </span>
  );
}
