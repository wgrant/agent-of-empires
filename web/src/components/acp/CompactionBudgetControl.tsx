import { useId, useRef } from "react";
import type { AgentSettingsSnapshot } from "../../lib/agentSettings";
import { formatTokens } from "../../lib/turnUsage";
import { CompactionThresholdScale } from "./CompactionThresholdScale";
import { CompactionCacheTiming } from "./CompactionCacheTiming";
import { ConfigRow } from "./SessionConfigControls";

interface Props {
  state: AgentSettingsSnapshot["auto_compaction"];
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
  idleValue?: string | null;
  onIdleChange?: (value: string | null) => void;
  running?: boolean;
  policyStatus?: string;
}
function validTokens(value: string | null, bounds: readonly [number, number]): number | null {
  const tokens = Number(value);
  return value !== null && value !== "" && Number.isSafeInteger(tokens) && tokens >= bounds[0] && tokens <= bounds[1]
    ? tokens
    : null;
}
const IDLE_BOUNDS = [100000, 1000000] as const;
const BUTTON =
  "min-h-8 rounded-md border border-surface-700 px-2 py-1 text-[11px] text-text-secondary hover:border-brand-600/60 disabled:opacity-50";

function TokenInput({
  label,
  value,
  bounds,
  onChange,
}: {
  label: string;
  value: string;
  bounds: readonly [number, number];
  onChange: (value: string) => void;
}) {
  const errorId = useId();
  const valid = validTokens(value, bounds) !== null;
  return (
    <span className="inline-flex min-w-0 flex-col gap-1">
      <label className="flex min-w-0 items-center gap-1 text-[11px] text-text-secondary">
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
      {!valid && (
        <span id={errorId} role="alert" className="text-[11px] text-status-warning">
          Enter {bounds[0].toLocaleString()} to {bounds[1].toLocaleString()} tokens.
        </span>
      )}
    </span>
  );
}
function AppliedPolicy({
  value,
  known,
  applied,
  running,
  idle,
}: {
  value: string | null;
  known?: boolean;
  applied?: number | null;
  running?: boolean;
  idle?: boolean;
}) {
  if (!running || (known && (value === null ? null : Number(value)) === applied)) return null;
  return (
    <p className="text-[11px] text-text-secondary">
      {!known
        ? "Applied policy unknown."
        : `Agent currently uses ${applied == null ? (idle ? "Off" : "its default policy") : formatTokens(applied) + " tokens"}.`}
    </p>
  );
}

export function CompactionBudgetControl({
  state,
  value,
  disabled,
  onChange,
  idleValue = null,
  onIdleChange,
  running,
  policyStatus,
}: Props) {
  const lastAuto = useRef(value ?? state.tokens?.toString());
  const lastIdle = useRef(idleValue ?? state.idle_tokens?.toString());
  if (!state.bounds) return null;
  const setAuto = (next: string | null) => {
    if (next !== null) lastAuto.current = next;
    onChange(next);
  };
  const setIdle = (next: string | null) => {
    if (next !== null) lastIdle.current = next;
    onIdleChange?.(next);
  };
  const custom = value !== null;
  const idle = !!state.idle_supported && !!onIdleChange;
  const idleEnabled = idle && idleValue !== null;
  const autoTokens = validTokens(value, state.bounds);
  const idleTokens = idleEnabled ? validTokens(idleValue, IDLE_BOUNDS) : null;
  return (
    <section aria-label="Context management" className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[10px] uppercase tracking-wider text-text-dim">Context management</h3>
      <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-secondary">Auto-compaction</span>
            <div className="flex flex-wrap items-start justify-end gap-1.5">
              {custom && (
                <TokenInput
                  label="Working context budget (tokens)"
                  value={value}
                  bounds={state.bounds}
                  onChange={setAuto}
                />
              )}
              <button
                type="button"
                data-testid="auto-compaction"
                className={BUTTON}
                onClick={() => setAuto(custom ? null : (lastAuto.current ?? String(state.tokens ?? state.bounds![0])))}
              >
                {custom ? "Use default" : "Default · Customize"}
              </button>
            </div>
          </div>
          <AppliedPolicy value={value} known={state.applied_known} applied={state.applied_tokens} running={running} />
        </div>
        {idle && (
          <div className="flex flex-col gap-1">
            <ConfigRow label="Before cache expiry">
              <button
                type="button"
                role="switch"
                aria-label="Compact before cache expiry"
                aria-checked={idleEnabled}
                data-testid="idle-compaction"
                className={BUTTON}
                onClick={() => setIdle(idleEnabled ? null : (lastIdle.current ?? "200000"))}
              >
                {idleEnabled ? "On" : "Off"}
              </button>
            </ConfigRow>
            <p className="text-[11px] text-text-secondary">
              Attempt compaction before estimated cache expiry when idle.
            </p>
            {idleEnabled && (
              <ConfigRow label="Minimum context">
                <TokenInput
                  label="Idle compaction minimum context (tokens)"
                  value={idleValue!}
                  bounds={IDLE_BOUNDS}
                  onChange={setIdle}
                />
              </ConfigRow>
            )}
            <AppliedPolicy
              value={idleValue}
              known={state.idle_applied_known}
              applied={state.idle_applied_tokens}
              running={running}
              idle
            />
          </div>
        )}
        {(custom || idleEnabled) && (
          <CompactionThresholdScale
            maximum={state.bounds[1]}
            contextTokens={state.prompt_cache?.contextTokens}
            status={policyStatus}
            markers={[
              ...(custom
                ? [
                    {
                      label: "Auto-compaction threshold",
                      value: autoTokens,
                      minimum: state.bounds[0],
                      maximum: state.bounds[1],
                      onChange: setAuto,
                    },
                  ]
                : []),
              ...(idleEnabled
                ? [
                    {
                      label: "Idle compaction minimum",
                      value: idleTokens,
                      minimum: IDLE_BOUNDS[0],
                      maximum: IDLE_BOUNDS[1],
                      idle: true,
                      onChange: setIdle,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </fieldset>
      {!(custom || idleEnabled) && policyStatus && (
        <p role="status" className="text-[11px] text-text-secondary">
          {policyStatus}
        </p>
      )}
      {autoTokens !== null && idleTokens !== null && idleTokens >= autoTokens && (
        <p className="text-[11px] text-text-secondary">
          The idle minimum is at or above auto-compaction; idle compaction may rarely become eligible.
        </p>
      )}
      {(custom || idleEnabled) && (
        <p className="text-[11px] text-text-secondary">Compaction uses tokens and may lose detail.</p>
      )}
      {state.idle_supported && <CompactionCacheTiming cache={state.prompt_cache} enabled={idleEnabled} />}
    </section>
  );
}
