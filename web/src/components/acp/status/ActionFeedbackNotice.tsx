import { Info, X } from "lucide-react";

/** A non-blocking failure from a user-initiated composer action. Durable work
 * such as queued or rejected prompts deliberately uses its own richer UI. */
export function ActionFeedbackNotice({
  title,
  detail,
  onDismiss,
  dismissLabel,
  testId,
}: {
  title: string;
  detail?: string;
  onDismiss: () => void;
  dismissLabel: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} role="status" className="border-t border-amber-900/40 bg-amber-950/20 px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-start gap-2 rounded-lg border border-amber-700/30 bg-amber-950/15 px-2.5 py-1.5 xl:max-w-4xl 2xl:max-w-5xl">
        <Info className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-5 text-amber-100">{title}</p>
          {detail && <p className="mt-0.5 font-mono text-[10px] text-amber-400/70">{detail}</p>}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex shrink-0 items-center justify-center rounded-md border border-amber-700/40 bg-amber-900/20 p-1 text-amber-200 hover:bg-amber-900/60"
          aria-label={dismissLabel}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
