import { useEffect, useState } from "react";
import { updateAgentLaunchOptions } from "../../lib/agentLaunchOptions";

interface BudgetState {
  tokens: number | null;
  bounds: [number, number] | null;
  applied_known: boolean;
  applied_tokens: number | null;
  running: boolean;
  starting: boolean;
}

export function CompactionBudgetControl({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<BudgetState | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [custom, setCustom] = useState<boolean | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`);
        if (!response.ok) throw new Error(`Could not load context settings (HTTP ${response.status})`);
        const body = (await response.json()) as { auto_compaction: BudgetState };
        if (!cancelled) setState(body.auto_compaction);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load context settings");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, revision]);

  const value = draft ?? state?.tokens?.toString() ?? "";
  const isCustom = custom ?? state?.tokens != null;
  const tokens = isCustom ? Number(value) : null;
  const valid =
    tokens === null ||
    (value !== "" &&
      state?.bounds != null &&
      Number.isSafeInteger(tokens) &&
      tokens >= state.bounds[0] &&
      tokens <= state.bounds[1]);
  const changed = state != null && tokens !== state.tokens;
  const pending = state != null && state.applied_known && state.tokens !== state.applied_tokens;
  const save = async (restart: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await updateAgentLaunchOptions(sessionId, { auto_compaction: { tokens }, restart });
      setState((previous) => previous && { ...previous, tokens });
      setDraft(null);
      setCustom(null);
      setRevision((previous) => previous + 1);
      setConfirmRestart(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save context settings");
    } finally {
      setSaving(false);
    }
  };

  const button = "rounded-md border border-surface-700 px-2 py-1 text-xs text-text-secondary disabled:opacity-50";
  return (
    <section aria-label="Context management" className="flex flex-col gap-2 text-xs">
      <h3 className="font-medium text-text-primary">Context management</h3>
      {!state && !error && <p className="text-text-dim">Loading context settings…</p>}
      {state && !state.bounds && (
        <p className="text-text-dim">This agent does not expose a custom auto-compaction budget.</p>
      )}
      {state?.bounds && (
        <>
          <label className="flex items-center justify-between gap-3">
            Auto-compaction
            <select
              aria-label="Auto-compaction"
              disabled={saving}
              value={isCustom ? "custom" : "default"}
              onChange={(e) => {
                setCustom(e.target.value === "custom");
                setDraft(String(state.tokens ?? state.bounds![0]));
                setConfirmRestart(false);
              }}
              className="rounded-md border border-surface-700 bg-surface-800 p-1"
            >
              <option value="default">Default</option>
              <option value="custom">Custom budget</option>
            </select>
          </label>
          {isCustom && (
            <label className="flex items-center justify-between gap-3">
              Working context budget (tokens)
              <input
                aria-label="Working context budget (tokens)"
                type="number"
                min={state.bounds[0]}
                max={state.bounds[1]}
                step="1000"
                value={value}
                disabled={saving}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setConfirmRestart(false);
                }}
                className="w-28 rounded-md border border-surface-700 bg-surface-800 p-1"
              />
            </label>
          )}
          <p className="text-[11px] text-text-dim">
            Default uses the agent’s own policy. A custom budget changes when compaction happens, not the model’s
            capacity. More frequent compaction can lose detail and does not always reduce cost.
          </p>
          {!valid && (
            <p role="alert" className="text-amber-300">
              Enter {state.bounds[0].toLocaleString()} to {state.bounds[1].toLocaleString()} tokens.
            </p>
          )}
          <p role="status" className="text-text-dim">
            {saving
              ? "Saving…"
              : state.starting
                ? "Starting agent with the saved policy…"
                : !state.running
                  ? "Applies on the next agent start."
                  : !state.applied_known
                    ? "Running agent’s budget is unknown. Restart to use the saved policy."
                    : pending
                      ? "Saved. Restart the agent to apply, or wait for its next start."
                      : "Applied to this agent’s launch configuration."}
          </p>
          {confirmRestart ? (
            <div className="flex flex-col gap-2">
              <p className="text-amber-300">
                Restarting interrupts any turn in progress. The conversation is retained.
              </p>
              <div className="flex gap-2">
                <button type="button" className={button} disabled={saving || !valid} onClick={() => void save(true)}>
                  Restart agent
                </button>
                <button type="button" className={button} disabled={saving} onClick={() => setConfirmRestart(false)}>
                  Cancel restart
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={button}
                disabled={saving || !valid || !changed}
                onClick={() => void save(false)}
              >
                Save for next start
              </button>
              {state.running && (
                <button
                  type="button"
                  className={button}
                  disabled={saving || !valid || (!changed && !pending && state.applied_known)}
                  onClick={() => setConfirmRestart(true)}
                >
                  Apply and restart…
                </button>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-rose-300">
          {error}
        </p>
      )}
    </section>
  );
}
