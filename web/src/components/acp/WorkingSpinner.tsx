import { useEffect, useState } from "react";

import { useNow } from "../../hooks/useNow";
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  VERB_INTERVAL_MS,
  chooseVerb,
  deriveSpinnerState,
} from "../../lib/acpRattle";

// Streaming silence before the "waiting on" label.
const STALLED_AFTER_SECS = 30;

/** "Ys" under a minute, else "Xm YYs" (zero-padded so the width holds steady). */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, "0")}s`;
}

export function WorkingSpinner({
  thinking,
  tool,
  cancelling,
  cancelEscalatesAt,
  compacting,
  compactionStartedAt = null,
  lastActivityRef,
}: {
  thinking: boolean;
  tool: string | null;
  cancelling: boolean;
  cancelEscalatesAt: string | null;
  compacting: boolean;
  /** When the running compaction began, as recorded, so its timer survives remounts. */
  compactionStartedAt?: string | null;
  lastActivityRef: React.RefObject<number>;
}) {
  const [frame, setFrame] = useState(0);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0xffffffff));
  const [stalledSecs, setStalledSecs] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      setSeed((s) => (s + 0x9e3779b9) | 0);
    }, VERB_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    // 0 is the hook's unset sentinel; pin it so the watchdog does not trip instantly.
    if (lastActivityRef.current === 0) {
      lastActivityRef.current = Date.now();
    }
    const t = window.setInterval(() => {
      setStalledSecs(Math.floor((Date.now() - lastActivityRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(t);
  }, [lastActivityRef]);

  const [escalatesInSecs, setEscalatesInSecs] = useState<number | null>(null);
  if (!cancelEscalatesAt && escalatesInSecs !== null) {
    setEscalatesInSecs(null);
  }
  useEffect(() => {
    if (!cancelEscalatesAt) return;
    const target = new Date(cancelEscalatesAt).getTime();
    if (Number.isNaN(target)) return;
    const tick = () => {
      setEscalatesInSecs(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    };
    // Deferred first tick so the countdown shows immediately without set-state-in-effect.
    const kickoff = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(t);
    };
  }, [cancelEscalatesAt]);

  const now = useNow(1000, compacting && compactionStartedAt != null);
  const compactionStartMs = compactionStartedAt ? Date.parse(compactionStartedAt) : NaN;
  const compactingSecs = Number.isNaN(compactionStartMs)
    ? stalledSecs
    : Math.max(0, Math.floor((now - compactionStartMs) / 1000));
  const showStalled = stalledSecs >= STALLED_AFTER_SECS;
  const toolInFlight = tool != null;
  // A /compact is silent for minutes, so it is labeled from the first tick
  // rather than reported as a stall.
  const label = cancelling
    ? escalatesInSecs != null && escalatesInSecs > 0
      ? `Stopping… (force in ${escalatesInSecs}s)`
      : "Stopping…"
    : compacting
      ? `Compaction in progress… ${formatElapsed(compactingSecs)}`
      : showStalled
        ? `Waiting on ${toolInFlight ? "tool" : "model"}… ${formatElapsed(stalledSecs)}`
        : chooseVerb(deriveSpinnerState(thinking, tool), seed, tool);

  return (
    <div data-testid="acp-working-spinner" className="flex items-center gap-2 text-sm italic text-text-muted">
      <span className="inline-block w-3 text-center font-mono text-brand-500" aria-hidden="true">
        {SPINNER_FRAMES[frame]}
      </span>
      <span>{label}</span>
    </div>
  );
}
