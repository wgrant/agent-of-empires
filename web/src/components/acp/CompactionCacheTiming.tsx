import { useEffect, useState } from "react";
import type { AgentSettingsSnapshot } from "../../lib/agentSettings";
import { formatTokens } from "../../lib/turnUsage";

export function CompactionCacheTiming({
  cache,
  enabled,
}: {
  cache: AgentSettingsSnapshot["auto_compaction"]["prompt_cache"];
  enabled: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = cache?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const stamp = (at: number) =>
    new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const expired = cache && cache.expiresAt <= now;
  return (
    <div className="text-[11px] text-text-secondary">
      <p>
        {cache
          ? expired
            ? "Estimated cache expiry has passed."
            : `Estimated cache expiry: ${stamp(cache.expiresAt)}.`
          : "Cache timing unknown; idle compaction cannot be scheduled from this observation."}
      </p>
      <details>
        <summary className="cursor-pointer py-1">Cache observations</summary>
        {cache ? (
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 tabular-nums">
            <dt>Last observed request</dt>
            <dd>{stamp(cache.refreshedAt)}</dd>
            <dt>Estimated expiry</dt>
            <dd>{stamp(cache.expiresAt)}</dd>
            <dt>Estimated lifetime</dt>
            <dd>{Math.round(cache.ttlMs / 60000)} min</dd>
            <dt>Context at that request</dt>
            <dd>{formatTokens(cache.contextTokens)} tokens</dd>
          </dl>
        ) : (
          <p>A request must report cache usage before timing can be estimated.</p>
        )}
        {enabled && (
          <p className="mt-1">
            Expiry is an estimate, not a guaranteed cache hit. When idle compaction is scheduled, the agent stays awake
            until the attempt.
          </p>
        )}
      </details>
    </div>
  );
}
