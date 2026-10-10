import { useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { formatTokens } from "../../lib/turnUsage";

interface Marker {
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  onChange: (value: string) => void;
}

function ThresholdMarker({ marker, scaleMax, describedBy }: { marker: Marker; scaleMax: number; describedBy: string }) {
  const dragging = useRef<{ id: number; x: number; value: number; width: number } | null>(null);
  const range = scaleMax - marker.minimum;
  const set = (tokens: number) => marker.onChange(String(Math.min(marker.maximum, Math.max(marker.minimum, tokens))));
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const start = dragging.current;
    if (start && start.width > 0)
      set(start.value + Math.round((((event.clientX - start.x) / start.width) * range) / 1000) * 1000);
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
      style={{ left: `${((marker.value - marker.minimum) / range) * 100}%`, top: 0 }}
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
      <span aria-hidden className="relative h-3 w-3 rounded-full border-2 border-brand-400 bg-surface-800" />
    </button>
  );
}

export function CompactionThresholdScale({
  maximum,
  markers,
}: {
  maximum: number;
  markers: (Omit<Marker, "value"> & { value: number | null })[];
}) {
  const helpId = useId();
  if (markers.every((marker) => marker.value === null)) return null;
  return (
    <div className="min-w-0">
      <div className="mx-[22px]" data-testid="compaction-scale">
        {markers.map((marker) => (
          <div key={marker.label}>
            <div className="relative h-11">
              <div aria-hidden className="absolute top-[22px] h-px w-full bg-surface-600" />
              {marker.value !== null && (
                <div
                  aria-hidden
                  style={{ width: `${((marker.value - marker.minimum) / (maximum - marker.minimum)) * 100}%` }}
                  className="absolute top-[21px] h-0.5 bg-brand-400/50"
                />
              )}
              {marker.value !== null && (
                <ThresholdMarker marker={{ ...marker, value: marker.value }} scaleMax={maximum} describedBy={helpId} />
              )}
            </div>
            <div className="flex justify-between text-[10px] tabular-nums text-text-secondary">
              <span>{formatTokens(marker.minimum)}</span>
              <span>Drag to adjust</span>
              <span>{formatTokens(maximum)} tokens</span>
            </div>
          </div>
        ))}
      </div>
      <span id={helpId} className="sr-only">
        Drag or use arrow keys to adjust the threshold.
      </span>
    </div>
  );
}
