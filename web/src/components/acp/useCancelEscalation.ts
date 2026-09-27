import { useCallback, useState } from "react";

/** Force when the server confirmed a cancel or the user already pressed Stop this turn. */
export function nextCancelAction(cancelling: boolean, alreadyRequested: boolean): "cancel" | "force" {
  return cancelling || alreadyRequested ? "force" : "cancel";
}

/** Stop-button handler: a graceful cancel first, a force-end on the second press.
 *  The server only confirms cancels for prompts it has in flight, so an orphaned
 *  turn relies on the local intent, keyed by session and turn so it resets itself.
 *  `forceNext` tells the button which press comes next. */
export function useCancelEscalation(
  sessionId: string,
  turnSeq: number,
  cancelling: boolean,
  cancelPrompt: () => Promise<void>,
  forceEndTurn: () => Promise<void>,
): { onCancel: () => Promise<void>; forceNext: boolean } {
  const [requested, setRequested] = useState<string | null>(null);
  const token = `${sessionId}:${turnSeq}`;
  const forceNext = nextCancelAction(cancelling, requested === token) === "force";

  const onCancel = useCallback(async () => {
    if (forceNext) {
      await forceEndTurn();
    } else {
      setRequested(token);
      await cancelPrompt();
    }
  }, [token, forceNext, cancelPrompt, forceEndTurn]);
  return { onCancel, forceNext };
}
