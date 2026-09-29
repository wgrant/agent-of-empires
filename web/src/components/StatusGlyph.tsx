import { isFreshIdle, type DisplayStatus } from "../lib/session";
import { useIdleDecayWindowMs } from "../lib/idleDecay";
import { RATTLES } from "../lib/rattles";
import { useRattle } from "../hooks/useRattle";

/** Which statuses get animated spinners vs static glyphs */
const STATUS_RATTLE: Partial<Record<DisplayStatus, keyof typeof RATTLES>> = {
  Running: "dots",
  Background: "drift",
  Waiting: "orbit",
  Starting: "breathe",
  Creating: "orbit",
};

/** Static glyphs for non-animated statuses (braille family) */
const STATIC_GLYPH: Record<DisplayStatus, string> = {
  Running: "⠋",
  Background: "⠋",
  Waiting: "⠃",
  Idle: "⠒",
  Error: "✕",
  Starting: "⠀",
  Stopped: "⠒",
  Unknown: "⠤",
  Deleting: "✕",
  Creating: "⠀",
};

/** Glyph for a dormant (idle-reaped, resumable) structured worker. */
const DORMANT_GLYPH = "⠶";

/** Animated status glyph that cycles through rattles frames. */
export function StatusGlyph({
  status,
  createdAt,
  idleEnteredAt,
  dormant = false,
}: {
  status: DisplayStatus;
  createdAt: string | null;
  idleEnteredAt?: string | null;
  dormant?: boolean;
}) {
  const idleDecayWindowMs = useIdleDecayWindowMs();
  const isFresh =
    !dormant && status === "Idle" && isFreshIdle({ status, idle_entered_at: idleEnteredAt ?? null }, idleDecayWindowMs);
  const rattleKey = STATUS_RATTLE[status];
  // A dormant worker is a resting state: no rattle, and its own static glyph.
  const rattle = dormant ? undefined : isFresh ? RATTLES.exhale : rattleKey ? RATTLES[rattleKey] : undefined;
  const parsed = createdAt ? Date.parse(createdAt) : 0;
  const epoch = Number.isNaN(parsed) ? 0 : parsed;
  const glyph = useRattle(rattle, epoch);

  return <>{glyph ?? (dormant ? DORMANT_GLYPH : STATIC_GLYPH[status])}</>;
}
