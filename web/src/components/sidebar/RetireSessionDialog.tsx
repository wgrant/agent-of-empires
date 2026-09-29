import { useRef, useState } from "react";

import { CancelButton, ConfirmButton, DANGER_BUTTON, Dialog } from "../Dialog";
import { useBusyAction, useConfirmKeys, useDialogFocus } from "../dialogHooks";

/** Confirms retiring an archived session. `onConfirm` resolves to why it was refused, or null once done. */
export function RetireSessionDialog({
  sessionTitle,
  branch,
  onConfirm,
  onCancel,
}: {
  sessionTitle: string;
  branch: string | null;
  onConfirm: () => Promise<string | null>;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [retiring, handleConfirm] = useBusyAction(async () => {
    const refusal = await onConfirm();
    setError(refusal);
    // Throwing ends the busy state, so a refused retire can be tried again.
    if (refusal) throw new Error(refusal);
  });
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  useDialogFocus(confirmButtonRef);
  useConfirmKeys(onCancel, handleConfirm, retiring);

  return (
    <Dialog
      id="retire-session-dialog"
      title="Retire session"
      onDismiss={onCancel}
      bodyClassName="space-y-2 px-5 py-4"
      footer={
        <>
          <CancelButton onClick={onCancel} disabled={retiring} />
          <ConfirmButton
            buttonRef={confirmButtonRef}
            onClick={handleConfirm}
            busy={retiring}
            testId="retire-session-confirm"
            className={DANGER_BUTTON}
          >
            {retiring ? "Retiring..." : "Retire"}
          </ConfirmButton>
        </>
      }
    >
      <p className="text-[13px] text-text-secondary">
        Retire <span className="font-mono text-text-primary">{sessionTitle}</span>? Its worktree directory and sandbox
        container are deleted to free disk space, including ignored files such as build output.
      </p>
      <p className="text-[13px] text-text-secondary">
        {branch ? (
          <>
            The branch <span className="font-mono text-text-primary">{branch}</span> and the transcript are kept.
          </>
        ) : (
          "The transcript is kept."
        )}{" "}
        The session stays archived and cannot be started again.
      </p>
      {error && (
        <pre
          data-testid="retire-session-error"
          className="whitespace-pre-wrap break-words rounded bg-status-error/10 p-2 text-xs text-status-error"
        >
          {error}
        </pre>
      )}
    </Dialog>
  );
}
