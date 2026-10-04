import type { AgentSettingsSnapshot } from "../../lib/agentSettings";
import { ChoiceDropdown, ConfigRow } from "./SessionConfigControls";

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
    <section aria-label="Context management" className="flex flex-col gap-1 text-xs">
      <fieldset disabled={disabled} className="min-w-0">
        <ConfigRow label="Auto-compaction">
          <div className="flex min-w-0 items-center justify-end gap-1.5">
            {custom && (
              <label className="flex min-w-0 items-center gap-1 text-[11px] text-text-secondary">
                <input
                  aria-label="Working context budget (tokens)"
                  type="number"
                  min={state.bounds[0]}
                  max={state.bounds[1]}
                  step="1000"
                  value={value}
                  disabled={disabled}
                  onChange={(e) => onChange(e.target.value)}
                  className="min-h-8 w-20 min-w-0 rounded-md border border-surface-700 bg-surface-800/60 px-2 py-1 text-[11px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span>tokens</span>
              </label>
            )}
            <ChoiceDropdown
              label="Auto-compaction"
              choices={[
                { value: "default", name: "Default", description: "Use the agent’s default compaction policy" },
                { value: "custom", name: "Custom", description: "Set a working context budget in tokens" },
              ]}
              current={custom ? "custom" : "default"}
              onSelect={(value) => onChange(value === "custom" ? String(state.tokens ?? state.bounds![0]) : null)}
              testId="auto-compaction"
              selectedLabel="Selected"
            />
          </div>
        </ConfigRow>
      </fieldset>
      <p className="text-[11px] text-text-dim">
        {custom
          ? "Changes when compaction happens, not the model window. May lose detail without reducing cost."
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
