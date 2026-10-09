import type { AgentSettingsSnapshot } from "../../lib/agentSettings";
import { ChoiceDropdown, ConfigRow } from "./SessionConfigControls";

interface Props {
  state: AgentSettingsSnapshot["auto_compaction"];
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
  idleValue?: string | null;
  onIdleChange?: (value: string | null) => void;
}

export function CompactionBudgetControl({ state, value, disabled, onChange, idleValue = null, onIdleChange }: Props) {
  if (!state.bounds) return null;
  const custom = value !== null;
  const valid =
    !custom ||
    (value !== "" &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= state.bounds[0] &&
      Number(value) <= state.bounds[1]);
  return (
    <details aria-label="Context management" className="flex flex-col gap-1 text-xs" open>
      <summary className="cursor-pointer py-1 text-text-secondary">Compaction</summary>
      {state.idle_supported && (
        <p className="text-[11px] text-text-dim">
          {state.prompt_cache
            ? `Last cache activity ${new Date(state.prompt_cache.refreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Estimated expiry ${new Date(state.prompt_cache.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (${Math.round(state.prompt_cache.ttlMs / 60000)} min lifetime).`
            : "Cache timing unavailable until a timed request reports cache usage."}
        </p>
      )}
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
      {state.idle_supported && onIdleChange && (
        <fieldset disabled={disabled} className="mt-2 flex min-w-0 flex-col gap-1">
          <ConfigRow label="Before cache expiry">
            <ChoiceDropdown
              label="Before cache expiry"
              choices={[
                { value: "off", name: "Off" },
                { value: "on", name: "When idle" },
              ]}
              current={idleValue === null ? "off" : "on"}
              onSelect={(selected) => onIdleChange(selected === "off" ? null : "200000")}
              testId="idle-compaction"
              selectedLabel="Selected"
            />
          </ConfigRow>
          {idleValue !== null && (
            <ConfigRow label="Minimum context">
              <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                <input
                  aria-label="Idle compaction minimum context (tokens)"
                  type="number"
                  min={100000}
                  max={1000000}
                  step={1000}
                  value={idleValue}
                  onChange={(event) => onIdleChange(event.target.value)}
                  className="min-h-8 w-24 rounded-md border border-surface-700 bg-surface-800/60 px-2 py-1 text-[11px]"
                />
                tokens
              </label>
            </ConfigRow>
          )}
          <p className="text-[11px] text-text-dim">
            Compacts large, idle conversations before estimated cache expiry. Uses tokens and may lose detail. Skips
            unknown cache timing; keeps the agent awake long enough to compact.
          </p>
          {idleValue !== null &&
            (!Number.isSafeInteger(Number(idleValue)) || Number(idleValue) < 100000 || Number(idleValue) > 1000000) && (
              <p role="alert" className="text-status-warning">
                Enter 100,000 to 1,000,000 tokens.
              </p>
            )}
        </fieldset>
      )}
    </details>
  );
}
