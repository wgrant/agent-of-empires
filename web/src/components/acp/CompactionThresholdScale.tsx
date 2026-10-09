import { useRef, type KeyboardEvent, type PointerEvent } from "react";
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
function ThresholdMarker({ marker, scaleMax }: { marker: Marker; scaleMax: number }) {
  const dragging = useRef<number | null>(null);
  const set = (tokens: number) => marker.onChange(String(Math.min(marker.maximum, Math.max(marker.minimum, tokens))));
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    if (rect.width > 0) set(Math.round((((event.clientX - rect.left) / rect.width) * scaleMax) / 1000) * 1000);
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
      aria-valuemin={marker.minimum}
      aria-valuemax={marker.maximum}
      aria-valuenow={marker.value}
      aria-valuetext={`${marker.value.toLocaleString()} tokens`}
      title={`${marker.label}: ${marker.value.toLocaleString()} tokens. Drag or use arrow keys.`}
      style={{ left: `${(marker.value / scaleMax) * 100}%`, top: marker.idle ? 32 : 0 }}
      className="absolute z-10 flex h-11 w-11 -translate-x-1/2 touch-none items-center justify-center rounded-md text-brand-400 focus-visible:outline-2 focus-visible:outline-brand-400 disabled:opacity-50"
      onKeyDown={key}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        dragging.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId) move(event);
      }}
      onPointerUp={(event) => {
        if (dragging.current === event.pointerId) {
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
        className={`absolute left-1/2 w-px bg-brand-400 ${marker.idle ? "top-[6px] h-3" : "bottom-[6px] h-3"}`}
      />
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
}: {
  maximum: number;
  markers: Marker[];
  contextTokens?: number;
}) {
  return (
    <div aria-label="Compaction thresholds" className="min-w-0">
      <div className="flex justify-between gap-2 text-[11px] text-text-secondary">
        <span>Drag thresholds</span>
        {contextTokens !== undefined && <span>Last request {formatTokens(contextTokens)}</span>}
      </div>
      <div className="relative mx-[22px] h-[76px]" data-testid="compaction-scale">
        <div aria-hidden className="absolute top-[38px] h-px w-full bg-surface-600" />
        {contextTokens !== undefined && (
          <span
            data-testid="compaction-context-tick"
            aria-hidden
            title={`Context at last request: ${contextTokens.toLocaleString()} tokens`}
            style={{ left: `${Math.min(100, (contextTokens / maximum) * 100)}%` }}
            className="absolute top-[32px] h-3 w-px bg-text-secondary"
          />
        )}
        {markers.map((marker) => (
          <ThresholdMarker key={marker.label} marker={marker} scaleMax={maximum} />
        ))}
      </div>
      <div className="flex justify-between text-[10px] tabular-nums text-text-secondary">
        <span>0</span>
        <span>{formatTokens(maximum)} tokens</span>
      </div>
    </div>
  );
}
