import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { formatTokens } from "../../lib/turnUsage";

interface Marker {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  idle?: boolean;
  onChange: (value: string) => void;
}

/** Separate lanes keep coincident thresholds independently reachable. */
function ThresholdMarker({ marker, scaleMax, describedBy }: { marker: Marker; scaleMax: number; describedBy: string }) {
  const dragging = useRef<{ id: number; x: number; value: number; width: number } | null>(null);
  const set = (tokens: number) => marker.onChange(String(Math.min(marker.maximum, Math.max(marker.minimum, tokens))));
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const start = dragging.current;
    if (start && start.width > 0)
      set(start.value + Math.round((((event.clientX - start.x) / start.width) * scaleMax) / 1000) * 1000);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 10000 : 1000;
    const next = {
      ArrowLeft: marker.value - step,
      ArrowDown: marker.value - step,
      ArrowRight: marker.value + step,
      ArrowUp: marker.value + step,
      PageDown: marker.value - 10000,
      PageUp: marker.value + 10000,
      Home: marker.minimum,
      End: marker.maximum,
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      set(next);
    }
  };
  return (
    <button
      type="button"
      role="slider"
      aria-label={marker.label}
      aria-describedby={describedBy}
      aria-valuemin={marker.minimum}
      aria-valuemax={marker.maximum}
      aria-valuenow={marker.value}
      aria-valuetext={`${marker.value.toLocaleString()} tokens`}
      title={`${marker.label}: ${marker.value.toLocaleString()} tokens. Drag or use arrow keys.`}
      style={{ left: `${(marker.value / scaleMax) * 100}%`, top: 0 }}
      className="absolute z-10 flex h-11 w-11 -translate-x-1/2 touch-none items-center justify-center rounded-md text-brand-400 focus-visible:outline-2 focus-visible:outline-brand-400 disabled:opacity-50"
      onKeyDown={key}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragging.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        dragging.current = {
          id: event.pointerId,
          x: event.clientX,
          value: marker.value,
          width: event.currentTarget.parentElement!.getBoundingClientRect().width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current?.id === event.pointerId && !event.currentTarget.matches(":disabled")) move(event);
      }}
      onPointerUp={(event) => {
        if (dragging.current?.id === event.pointerId) {
          dragging.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    >
      <span
        aria-hidden
        className={`relative h-3 w-3 border-2 border-brand-400 bg-surface-800 ${marker.idle ? "rounded-full" : "rotate-45"}`}
      />
    </button>
  );
}

export function CompactionThresholdScale({
  maximum,
  markers,
  contextTokens,
  status,
}: {
  maximum: number;
  markers: (Omit<Marker, "value"> & { value: number | null })[];
  contextTokens?: number;
  status?: string;
}) {
  const helpId = useId();
  return (
    <div aria-label="Compaction policy editor" className="min-w-0">
      <div className="flex flex-wrap justify-between gap-1 text-[11px] text-text-secondary">
        <span className="font-medium">Compaction policy</span>
        {status && <span role="status">{status}</span>}
      </div>
      <div className="mx-[22px]" data-testid="compaction-scale">
        {markers.map((marker) => (
          <div key={marker.label} className="mt-2">
            <div className="flex justify-between gap-2 text-[11px] text-text-secondary">
              <span>{marker.idle ? "Idle minimum" : "Auto-compaction"}</span>
              <span className="tabular-nums">
                {marker.value === null ? "Enter a valid value" : formatTokens(marker.value) + " tokens"}
              </span>
            </div>
            <div className="relative h-11">
              <div aria-hidden className="absolute top-[22px] h-px w-full bg-surface-600" />
              {contextTokens !== undefined && (
                <span
                  aria-hidden
                  title={`Context at last observed request: ${contextTokens.toLocaleString()} tokens`}
                  style={{ left: `${Math.min(100, (contextTokens / maximum) * 100)}%` }}
                  className="absolute top-[16px] h-3 w-px bg-text-secondary"
                />
              )}
              {marker.value !== null && (
                <ThresholdMarker marker={{ ...marker, value: marker.value }} scaleMax={maximum} describedBy={helpId} />
              )}
            </div>
          </div>
        ))}
        <div className="flex justify-between text-[10px] tabular-nums text-text-secondary">
          <span>0</span>
          <span>{formatTokens(maximum)} tokens</span>
        </div>
      </div>
      <p id={helpId} className="mt-1 text-[11px] text-text-secondary">
        Policy editing scale, not model capacity. Drag or use arrow keys.
      </p>
      <p className="mt-1 text-[11px] text-text-secondary">
        {contextTokens === undefined
          ? "Context observation unavailable."
          : `Context at last observed request: ${formatTokens(contextTokens)} tokens.`}
      </p>
    </div>
  );
}
