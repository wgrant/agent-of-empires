import { useState, type ReactNode } from "react";
import { ChevronDown, LoaderCircle, RotateCcw, X } from "lucide-react";

import { connectionStatusCompactLabel, connectionStatusPresentation } from "../acp/status/connectionStatus";

import type {
  ConnectionDiagnosticObservation,
  ConnectionDiagnostics,
  ConnectionEdgeState,
  ConnectionHopState,
} from "../acp/status/connectionStatus";

function stateTextClass(state: ConnectionHopState | ConnectionEdgeState) {
  if (state === "failed" || state === "blocked") return "text-status-error";
  if (state === "working") return "text-status-warning";
  return "text-text-muted";
}

function ConnectionNode({ label, state }: { label: string; state: ConnectionHopState }) {
  const marker =
    state === "working" ? (
      <LoaderCircle className="size-2.5 animate-spin text-status-warning" aria-hidden="true" />
    ) : state === "blocked" || state === "failed" ? (
      <span className="flex size-2.5 items-center justify-center text-[9px] font-bold leading-none text-status-error">
        !
      </span>
    ) : (
      <span
        className={`size-2 rounded-full ${state === "ready" ? "bg-text-muted" : "border border-surface-500"}`}
        aria-hidden="true"
      />
    );
  return (
    <span className="flex shrink-0 items-center gap-1">
      {marker}
      {label}
    </span>
  );
}

function ConnectionEdge({ state, label }: { state: ConnectionEdgeState; label: string }) {
  const lineClass =
    state === "ready"
      ? "border-text-muted/50"
      : state === "working"
        ? "border-status-warning/70"
        : state === "blocked" || state === "failed"
          ? "border-status-error/70"
          : "border-surface-600 border-dashed";
  return (
    <span className="relative flex w-6 shrink-0 items-center justify-center" aria-label={`${label}: ${state}`}>
      <span className={`w-full border-t ${lineClass}`} aria-hidden="true" />
      {state === "working" && (
        <LoaderCircle className="absolute size-3 animate-spin bg-surface-900 text-status-warning" aria-hidden="true" />
      )}
    </span>
  );
}

export function ConnectionRoute({ diagnostics }: { diagnostics: ConnectionDiagnostics }) {
  return (
    <div
      className="flex shrink-0 items-center text-[10px] font-mono uppercase tracking-wide text-text-muted"
      data-testid="connection-route"
    >
      <ConnectionNode label="Device" state={diagnostics.device} />
      <ConnectionEdge state={diagnostics.deviceToServer} label="Device to AoE" />
      <ConnectionNode label="AoE" state={diagnostics.server} />
      {diagnostics.targetLabel && (
        <>
          <ConnectionEdge state={diagnostics.serverToAgent} label={`AoE to ${diagnostics.targetLabel.toLowerCase()}`} />
          <ConnectionNode label={diagnostics.targetLabel} state={diagnostics.agent} />
        </>
      )}
    </div>
  );
}

function Observation({ observation }: { observation: ConnectionDiagnosticObservation }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-x-3 py-1 text-xs">
      <span className="text-text-muted">{observation.label}</span>
      <span className={`min-w-0 text-right ${stateTextClass(observation.state)}`}>{observation.value}</span>
    </div>
  );
}

export function ConnectionDiagnosticsDetails({
  diagnostics,
  onReconnect,
  onClose,
  actions,
}: {
  diagnostics: ConnectionDiagnostics;
  onReconnect?: () => void;
  onClose?: () => void;
  actions?: ReactNode;
}) {
  return (
    <div className="w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-surface-700 bg-surface-850 p-3 shadow-xl">
      <div className="mb-3 flex items-center justify-between gap-3">
        <ConnectionRoute diagnostics={diagnostics} />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close connection details"
            className="rounded p-1 text-text-muted hover:bg-surface-700 hover:text-text-primary"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="space-y-2">
        {diagnostics.sections.map((section) => (
          <section key={section.id} className="border-t border-surface-700/70 pt-2 first:border-t-0 first:pt-0">
            <h3 className="text-[10px] font-mono uppercase tracking-wide text-text-dim">{section.label}</h3>
            {section.observations.map((observation) => (
              <Observation key={`${section.id}-${observation.label}`} observation={observation} />
            ))}
          </section>
        ))}
      </div>
      {(actions || (onReconnect && diagnostics.retriesExhausted)) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {actions}
          {onReconnect && diagnostics.retriesExhausted && (
            <button
              type="button"
              onClick={onReconnect}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-status-error/40 bg-status-error/10 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-status-error hover:bg-status-error/20"
            >
              <RotateCcw className="size-3" />
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Incident-only overlay. Its caller reserves a compact top inset so the
 * capsule does not cover the first transcript line. */
export function ConnectionIncidentBubble({
  diagnostics,
  onReconnect,
  actions,
}: {
  diagnostics: ConnectionDiagnostics;
  onReconnect?: () => void;
  actions?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const presentation = connectionStatusPresentation(diagnostics.primary);
  const tone = presentation.tone === "error" ? "text-status-error" : "text-status-warning";
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3" role="status">
      <div className="pointer-events-auto relative max-w-full">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label="Show connection details"
          aria-description={presentation.description}
          className="flex max-w-full items-center gap-2 rounded-full border border-surface-700 bg-surface-850/95 px-3 py-1.5 shadow-lg backdrop-blur-sm hover:bg-surface-800"
        >
          <ConnectionRoute diagnostics={diagnostics} />
          <span
            className={`hidden max-w-40 truncate text-xs sm:inline ${tone}`}
            data-testid="connection-incident-summary"
            title={presentation.description}
          >
            {connectionStatusCompactLabel(diagnostics)}
          </span>
          <ChevronDown
            className={`size-3 shrink-0 text-text-muted transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {expanded && (
          <div className="absolute left-1/2 top-[calc(100%+0.5rem)] -translate-x-1/2 max-md:fixed max-md:inset-x-3 max-md:top-auto max-md:bottom-3 max-md:translate-x-0">
            <ConnectionDiagnosticsDetails
              diagnostics={diagnostics}
              onReconnect={onReconnect}
              onClose={() => setExpanded(false)}
              actions={actions}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function GlobalConnectionStatusButton({
  diagnostics,
  onReconnect,
}: {
  diagnostics: ConnectionDiagnostics;
  onReconnect?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const presentation = connectionStatusPresentation(diagnostics.primary);
  const tone =
    presentation.tone === "error"
      ? "text-status-error"
      : presentation.tone === "warning"
        ? "text-status-warning"
        : "text-text-muted";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label="Show connection status"
        aria-description={presentation.description}
        title={presentation.description}
        className={`flex h-8 items-center gap-1.5 rounded-md px-2 text-[10px] font-mono uppercase tracking-wide transition-colors hover:bg-surface-700/60 ${tone}`}
      >
        {presentation.working ? (
          <LoaderCircle className="size-3 animate-spin" />
        ) : (
          <span
            className={`size-2 rounded-full ${
              presentation.tone === "error"
                ? "bg-status-error"
                : presentation.tone === "warning"
                  ? "bg-status-warning"
                  : "bg-text-muted"
            }`}
          />
        )}
        <span className="hidden lg:inline">{connectionStatusCompactLabel(diagnostics)}</span>
      </button>
      {expanded && (
        <div className="fixed right-3 top-14 z-50 max-md:inset-x-3 max-md:top-auto max-md:bottom-3">
          <ConnectionDiagnosticsDetails
            diagnostics={diagnostics}
            onReconnect={onReconnect}
            onClose={() => setExpanded(false)}
          />
        </div>
      )}
    </div>
  );
}
