export type ConversationNextStep =
  | { kind: "catching_up" }
  | { kind: "working" }
  | { kind: "scheduled_wakeup" }
  | { kind: "monitoring" }
  | null;

/** The tail has one primary conversation status. Catch-up takes precedence
 * over a cached running flag because replay has not yet established whether
 * that work is still current. */
export function deriveConversationNextStep({
  initialCatchup,
  turnActive,
  nextWakeupAt,
  monitorArmed,
}: {
  initialCatchup: boolean;
  turnActive: boolean;
  nextWakeupAt: string | null;
  monitorArmed: boolean;
}): ConversationNextStep {
  if (initialCatchup) return { kind: "catching_up" };
  if (turnActive) return { kind: "working" };
  if (nextWakeupAt) return { kind: "scheduled_wakeup" };
  if (monitorArmed) return { kind: "monitoring" };
  return null;
}
