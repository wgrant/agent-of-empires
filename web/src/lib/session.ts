import type { SessionResponse, SessionStatus } from "./types";

/** Freshness window for Stop-hooked Idle sessions; 0 (off) mirrors the Rust `theme.idle_decay_minutes` default. */
export const IDLE_DECAY_WINDOW_MS = 0;

/** A status as the sidebar shows it: `Background` is an Idle session whose
 *  own background work is still running, which the agent resumes from by
 *  itself, so it is busy rather than waiting on the user. */
export type DisplayStatus = SessionStatus | "Background";

export function displayStatus(session: {
  status: DisplayStatus;
  background?: SessionResponse["background"];
}): DisplayStatus {
  return session.status === "Idle" && (session.background?.running ?? 0) > 0 ? "Background" : session.status;
}

export const BACKGROUND_STATUS_HINT = "Waiting on background work";

export const STATUS_DOT_CLASS: Record<DisplayStatus, string> = {
  Running: "bg-status-running",
  Background: "bg-status-running/60",
  Waiting: "bg-status-waiting",
  Idle: "bg-status-idle",
  Error: "bg-status-error",
  Starting: "bg-status-starting",
  Stopped: "bg-status-stopped",
  Unknown: "bg-status-idle",
  Deleting: "bg-status-error",
  Creating: "bg-status-starting",
};

export const STATUS_TEXT_CLASS: Record<DisplayStatus, string> = {
  Running: "text-status-running",
  Background: "text-status-running/60",
  Waiting: "text-status-waiting",
  Idle: "text-status-idle",
  Error: "text-status-error",
  Starting: "text-status-starting",
  Stopped: "text-status-stopped",
  Unknown: "text-status-idle",
  Deleting: "text-status-error",
  Creating: "text-status-starting",
};

/** Null unless Idle with a non-future `idle_entered_at`. */
export function idleAgeMs(
  session: Pick<SessionResponse, "idle_entered_at"> & { status: DisplayStatus },
): number | null {
  if (session.status !== "Idle") return null;
  if (!session.idle_entered_at) return null;
  const since = Date.parse(session.idle_entered_at);
  if (Number.isNaN(since)) return null;
  const age = Date.now() - since;
  return age >= 0 ? age : null;
}

/** Idle within `windowMs` of the Stop hook, which counts as needing attention. */
export function isFreshIdle(
  session: Pick<SessionResponse, "idle_entered_at"> & { status: DisplayStatus },
  windowMs: number = IDLE_DECAY_WINDOW_MS,
): boolean {
  if (windowMs <= 0) return false;
  const age = idleAgeMs(session);
  return age !== null && age < windowMs;
}

/** Idle picks a fresh or decayed tier; static classes keep Tailwind's JIT happy. */
export function getStatusDotClass(
  session: Pick<SessionResponse, "idle_entered_at" | "dormant" | "background"> & { status: DisplayStatus },
  windowMs: number = IDLE_DECAY_WINDOW_MS,
): string {
  // A dormant worker gets its own dim-amber dot; a deliberate Stop is never dormant.
  if (session.dormant) {
    return "bg-status-dormant";
  }
  if (displayStatus(session) === "Idle" && isFreshIdle(session, windowMs)) {
    return "bg-status-fresh-idle";
  }
  return STATUS_DOT_CLASS[displayStatus(session)] ?? "bg-status-idle";
}

export function getStatusTextClass(
  session: Pick<SessionResponse, "idle_entered_at" | "dormant" | "background"> & { status: DisplayStatus },
  windowMs: number = IDLE_DECAY_WINDOW_MS,
): string {
  if (session.dormant) {
    return "text-status-dormant";
  }
  if (displayStatus(session) === "Idle" && isFreshIdle(session, windowMs)) {
    return "text-status-fresh-idle";
  }
  return STATUS_TEXT_CLASS[displayStatus(session)] ?? "text-status-idle";
}

/** Live (not archived/snoozed/trashed), resting (Idle/Unknown) session with an unseen finished turn, excluding the
 *  one currently open. Mirrors the sidebar row's own gate (`rowModel.ts`'s `showUnreadGlyph`): a live status like
 *  Running or Waiting outranks the unread marker, since a session already busy on a new turn isn't something that
 *  needs attention *now* just because an earlier turn went unread. */
export function sessionIsUnread(s: SessionResponse, activeSessionId: string | null): boolean {
  if (s.archived_at != null || s.snoozed_until != null || s.trashed_at != null) return false;
  const status = displayStatus(s);
  if (status !== "Idle" && status !== "Unknown") return false;
  return s.unread === true && s.id !== activeSessionId;
}

/** Live (not archived/snoozed/trashed) session waiting for input. */
export function sessionIsWaitingForInput(s: SessionResponse): boolean {
  if (s.archived_at != null || s.snoozed_until != null || s.trashed_at != null) return false;
  return s.status === "Waiting";
}

/** Count of unread sessions for the top-bar badge; 0 when the user has turned the unread indicator off, mirroring
 *  the sidebar row's own gate (`rowModel.ts`) so a disabled indicator doesn't reappear here. */
export function countUnreadSessions(
  sessions: readonly SessionResponse[],
  activeSessionId: string | null,
  unreadIndicatorEnabled: boolean,
): number {
  if (!unreadIndicatorEnabled) return 0;
  return sessions.filter((s) => sessionIsUnread(s, activeSessionId)).length;
}

/** Count of sessions waiting for input, for the top-bar badge. */
export function countWaitingSessions(sessions: readonly SessionResponse[]): number {
  return sessions.filter(sessionIsWaitingForInput).length;
}

/** Fresh-idle counts as active. */
export function isSessionActive(
  session: (Pick<SessionResponse, "idle_entered_at" | "background"> & { status: DisplayStatus }) | DisplayStatus,
  windowMs: number = IDLE_DECAY_WINDOW_MS,
): boolean {
  const status = typeof session === "string" ? session : displayStatus(session);
  if (status === "Running" || status === "Background" || status === "Waiting" || status === "Starting") {
    return true;
  }
  return typeof session !== "string" && status === "Idle" && isFreshIdle(session, windowMs);
}
