import type { AgentSettingsSnapshot } from "../../lib/agentSettings";

interface Props {
  state: AgentSettingsSnapshot["auto_compaction"];
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}

export function CompactionBudgetControl({ state, value, disabled, onChange }: Props) {
  if (!state.bounds) return null;
  const custom = value !== null;
  const valid =
    !custom ||
    (value !== "" &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= state.bounds[0] &&
      Number(value) <= state.bounds[1]);
  return (
    <section aria-label="Context management" className="flex flex-col gap-2 text-xs">
      <label className="flex items-center justify-between gap-3">
        Auto-compaction
        <select
          aria-label="Auto-compaction"
          disabled={disabled}
          value={custom ? "custom" : "default"}
          onChange={(e) => onChange(e.target.value === "custom" ? String(state.tokens ?? state.bounds![0]) : null)}
          className="min-h-8 shrink-0 rounded-md border border-surface-700 bg-surface-800 p-1"
        >
          <option value="default">Default</option>
          <option value="custom">Custom budget</option>
        </select>
      </label>
      {custom && (
        <label className="flex items-center justify-between gap-3">
          Working context budget (tokens)
          <input
            aria-label="Working context budget (tokens)"
            type="number"
            min={state.bounds[0]}
            max={state.bounds[1]}
            step="1000"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-8 w-28 shrink-0 rounded-md border border-surface-700 bg-surface-800 p-1"
          />
        </label>
      )}
      <p className="text-[11px] text-text-dim">
        {custom
          ? "A custom budget changes when compaction happens, not the model’s capacity. More frequent compaction can lose detail and does not always reduce cost."
          : "Uses the agent’s default compaction policy."}
      </p>
      {!valid && (
        <p role="alert" className="text-amber-300">
          Enter {state.bounds[0].toLocaleString()} to {state.bounds[1].toLocaleString()} tokens.
        </p>
      )}
    </section>
  );
}
