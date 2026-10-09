import { useId } from "react";
import type { AgentSettingsSnapshot } from "../../lib/agentSettings";
import { formatTokens } from "../../lib/turnUsage";
import { CompactionThresholdScale } from "./CompactionThresholdScale";
import { ChoiceDropdown, ConfigRow } from "./SessionConfigControls";

interface Props {
  state: AgentSettingsSnapshot["auto_compaction"];
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
  idleValue?: string | null;
  onIdleChange?: (value: string | null) => void;
}

function validTokens(value: string | null, bounds: readonly [number, number]): number | null {
  const tokens = Number(value);
  return value !== null && value !== "" && Number.isSafeInteger(tokens) && tokens >= bounds[0] && tokens <= bounds[1]
    ? tokens
    : null;
}
const IDLE_BOUNDS = [100000, 1000000] as const;

function TokenInput({
  label,
  name,
  value,
  bounds,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  bounds: readonly [number, number];
  onChange: (value: string) => void;
}) {
  const errorId = useId();
  const valid = validTokens(value, bounds) !== null;
  return (
    <div className="flex flex-col gap-1">
      <ConfigRow label={name}>
        <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-text-secondary">
          <input
            aria-label={label}
            aria-invalid={!valid}
            aria-describedby={valid ? undefined : errorId}
            type="number"
            min={bounds[0]}
            max={bounds[1]}
            step="1000"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-h-8 w-24 min-w-0 rounded-md border border-surface-700 bg-surface-800/60 px-2 py-1 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          tokens
        </label>
      </ConfigRow>
      {!valid && (
        <p id={errorId} role="alert" className="text-[11px] text-status-warning">
          Enter {bounds[0].toLocaleString()} to {bounds[1].toLocaleString()} tokens.
        </p>
      )}
    </div>
  );
}

export function CompactionBudgetControl({ state, value, disabled, onChange, idleValue = null, onIdleChange }: Props) {
  if (!state.bounds) return null;
  const custom = value !== null;
  const idle = !!state.idle_supported && !!onIdleChange;
  const idleEnabled = idle && idleValue !== null;
  const autoTokens = validTokens(value, state.bounds);
  const idleTokens = idleEnabled ? validTokens(idleValue, IDLE_BOUNDS) : null;
  const cache = state.prompt_cache;
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <section aria-label="Context management" className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[10px] uppercase tracking-wider text-text-dim">Context management</h3>
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
        {(custom || idleEnabled) && (
          <CompactionThresholdScale
            maximum={state.bounds[1]}
            contextTokens={cache?.contextTokens}
            markers={[
              ...(autoTokens === null
                ? []
                : [
                    {
                      label: "Auto-compaction threshold",
                      value: autoTokens,
                      minimum: state.bounds[0],
                      maximum: state.bounds[1],
                      onChange,
                    },
                  ]),
              ...(idleTokens === null
                ? []
                : [
                    {
                      label: "Idle compaction minimum",
                      value: idleTokens,
                      minimum: IDLE_BOUNDS[0],
                      maximum: IDLE_BOUNDS[1],
                      idle: true,
                      onChange: onIdleChange!,
                    },
                  ]),
            ]}
          />
        )}
        <ConfigRow label={custom ? "◆ Auto-compaction" : "Auto-compaction"}>
          <ChoiceDropdown
            label="Auto-compaction"
            choices={[
              { value: "default", name: "Default", description: "Use the agent’s default compaction policy" },
              { value: "custom", name: "Custom", description: "Set a compaction threshold in tokens" },
            ]}
            current={custom ? "custom" : "default"}
            onSelect={(selected) => onChange(selected === "custom" ? String(state.tokens ?? state.bounds![0]) : null)}
            testId="auto-compaction"
            selectedLabel="Selected"
          />
        </ConfigRow>
        {custom && (
          <TokenInput
            label="Working context budget (tokens)"
            name="Threshold"
            value={value}
            bounds={state.bounds}
            onChange={onChange}
          />
        )}
        {idle && (
          <>
            <ConfigRow label={idleEnabled ? "● Compact while idle" : "Compact while idle"}>
              <ChoiceDropdown
                label="Compact while idle"
                choices={[
                  { value: "off", name: "Off" },
                  { value: "on", name: "On" },
                ]}
                current={idleEnabled ? "on" : "off"}
                onSelect={(selected) => onIdleChange!(selected === "off" ? null : "200000")}
                testId="idle-compaction"
                selectedLabel="Selected"
              />
            </ConfigRow>
            {idleEnabled && (
              <TokenInput
                label="Idle compaction minimum context (tokens)"
                name="Minimum context"
                value={idleValue!}
                bounds={IDLE_BOUNDS}
                onChange={onIdleChange!}
              />
            )}
          </>
        )}
      </fieldset>
      {(custom || idleEnabled) && (
        <p className="text-[11px] text-text-secondary">
          {custom && "Auto-compaction overrides the agent’s policy, not the model window. "}
          {idleEnabled && "Idle compaction runs before estimated cache expiry above the minimum context. "}
          Compaction uses tokens and may lose detail.
        </p>
      )}
      {state.idle_supported && (
        <details className="text-[11px] text-text-secondary">
          <summary className="cursor-pointer py-1">
            Cache timing{cache ? ` · estimated expiry ${time(cache.expiresAt)}` : " · unavailable"}
          </summary>
          {cache ? (
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 gap-y-1 tabular-nums">
              <dt>Last cache activity</dt>
              <dd>{time(cache.refreshedAt)}</dd>
              <dt>Estimated expiry</dt>
              <dd>{time(cache.expiresAt)}</dd>
              <dt>Observed lifetime</dt>
              <dd>{Math.round(cache.ttlMs / 60000)} min</dd>
              <dt>Context at last request</dt>
              <dd>{formatTokens(cache.contextTokens)} tokens</dd>
            </dl>
          ) : (
            <p>Cache timing is available after a timed request reports cache usage.</p>
          )}
          {idleEnabled && (
            <p className="mt-1">Skips unknown cache timing and keeps an eligible agent awake long enough to compact.</p>
          )}
        </details>
      )}
    </section>
  );
}
