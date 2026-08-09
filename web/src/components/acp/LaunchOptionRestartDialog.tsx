import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  optionName: string;
  enabled: boolean;
  warning?: string;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

/** Confirmation shared by agent settings that are persisted immediately but
 * only take effect after replacing the session's adapter process. */
export function LaunchOptionRestartDialog({ optionName, enabled, warning, onConfirm, onCancel }: Props) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const handleConfirm = useCallback(async () => {
    setRestarting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (reason) {
      setRestarting(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [onConfirm]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    confirmButtonRef.current?.focus();
    return () => previousFocusRef.current?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !restarting) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, restarting]);

  const action = enabled ? "Enable" : "Disable";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="launch-option-dialog-title"
      data-testid="launch-option-restart-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 animate-fade-in"
      onClick={() => !restarting && onCancel()}
    >
      <div
        className="w-[440px] max-w-[90vw] rounded-lg border border-surface-700/50 bg-surface-800 shadow-2xl animate-slide-up"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-surface-700 px-5 py-4">
          <h2 id="launch-option-dialog-title" className="text-sm font-semibold text-text-primary">
            {action} {optionName} and restart agent?
          </h2>
        </div>
        <div className="space-y-3 px-5 py-4 text-[13px] text-text-secondary">
          <p>
            This setting takes effect at launch. Agent of Empires will save it and restart only this session&apos;s
            agent. The conversation is retained, but an in-progress turn will be interrupted.
          </p>
          {enabled && warning && <p className="rounded-md bg-rose-950/40 px-3 py-2 text-rose-200">{warning}</p>}
          {error && (
            <p role="alert" className="rounded-md bg-rose-950/40 px-3 py-2 text-rose-200">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 border-t border-surface-700 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={restarting}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-700/50 hover:text-text-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={() => void handleConfirm()}
            disabled={restarting}
            data-testid="launch-option-confirm"
            className={[
              "flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50",
              enabled ? "bg-rose-700 text-white hover:bg-rose-600" : "bg-brand-600 text-surface-950 hover:bg-brand-500",
            ].join(" ")}
          >
            {restarting ? "Restarting..." : `${action} and restart`}
          </button>
        </div>
      </div>
    </div>
  );
}
