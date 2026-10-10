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
    <details className="text-[11px] text-text-secondary">
      <summary className="cursor-pointer py-1">
        Cache timing · {cache ? (expired ? "expired" : `estimated expiry ${stamp(cache.expiresAt)}`) : "unavailable"}
      </summary>
      {cache ? (
        <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 tabular-nums">
          <dt>Last cache activity</dt>
          <dd>{stamp(cache.refreshedAt)}</dd>
          <dt>Estimated expiry</dt>
          <dd>{stamp(cache.expiresAt)}</dd>
          <dt>Observed lifetime</dt>
          <dd>{Math.round(cache.ttlMs / 60000)} min</dd>
          <dt>Context at last observed request</dt>
          <dd>{formatTokens(cache.contextTokens)} tokens</dd>
        </dl>
      ) : (
        <p>Cache timing is available after a timed request reports cache usage.</p>
      )}
      {enabled && (
        <p className="mt-1">
          Unknown timing is skipped. An eligible agent is kept awake long enough to attempt compaction.
        </p>
      )}
    </details>
  );
}
