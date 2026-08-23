import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

export type LifecycleNoticeTone = "info" | "warning" | "error";
export type LifecycleActionPhase = "idle" | "pending" | "accepted" | "failed";

export interface LifecycleNoticeAction {
  label: string;
  pendingLabel: string;
  acceptedLabel?: string;
  phase?: LifecycleActionPhase;
  error?: string | null;
  onInvoke: () => void;
}

const TONE_CLASS: Record<LifecycleNoticeTone, { frame: string; detail: string; button: string }> = {
  info: {
    frame: "border-status-starting/30 bg-status-starting/10 text-status-starting",
    detail: "text-text-secondary",
    button: "border-status-starting/40 bg-status-starting/15 text-text-primary hover:bg-status-starting/25",
  },
  warning: {
    frame: "border-status-warning/30 bg-status-warning/10 text-status-warning",
    detail: "text-status-warning/90",
    button: "border-status-warning/40 bg-status-warning/20 text-status-warning hover:bg-status-warning/30",
  },
  error: {
    frame: "border-status-error/40 bg-status-error/10 text-status-error",
    detail: "text-text-secondary",
    button: "border-status-error/50 bg-status-error/15 text-text-primary hover:bg-status-error/25",
  },
};

function actionLabel(action: LifecycleNoticeAction): string {
  if (action.phase === "pending") return action.pendingLabel;
  if (action.phase === "accepted") return action.acceptedLabel ?? action.pendingLabel;
  return action.label;
}

/** Shared presentation for the transcript's one lifecycle-incident slot. */
export function LifecycleIncidentNotice({
  title,
  detail,
  tone,
  working = false,
  primaryAction,
  secondaryAction,
  children,
  testId,
}: {
  title: string;
  detail: ReactNode;
  tone: LifecycleNoticeTone;
  working?: boolean;
  primaryAction?: LifecycleNoticeAction;
  secondaryAction?: LifecycleNoticeAction;
  children?: ReactNode;
  testId?: string;
}) {
  const classes = TONE_CLASS[tone];
  const actions = [primaryAction, secondaryAction].filter((action): action is LifecycleNoticeAction => !!action);
  const failedAction = actions.find((action) => action.phase === "failed" && action.error);
  return (
    <div
      className={`border-b px-4 py-3 ${classes.frame}`}
      role={tone === "error" ? "alert" : "status"}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {working && <RotateCcw className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
            <span>{title}</span>
          </div>
          <div className={`mt-1 text-xs ${classes.detail}`}>{detail}</div>
        </div>
        {actions.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {actions.map((action) => {
              const disabled = action.phase === "pending" || action.phase === "accepted";
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onInvoke}
                  disabled={disabled}
                  className={`rounded-md border px-3 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60 ${classes.button}`}
                >
                  {actionLabel(action)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {failedAction?.error && <div className="mt-2 text-xs text-status-error">{failedAction.error}</div>}
      {children}
    </div>
  );
}
