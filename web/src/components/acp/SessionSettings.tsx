// Session settings: a read-only summary chip in the composer footer that opens a
// dialog holding the agent's mode, model, effort, thinking display, and launch options.

import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useSessionThinkingDisplay } from "../../hooks/useSessionThinkingDisplay";
import type { AcpState } from "../../lib/acpTypes";
import { agentLaunchOptions, updateAgentLaunchOptions, type AgentLaunchOption } from "../../lib/agentLaunchOptions";
import { useAgentProfile } from "../../lib/agentProfileContext";
import { resolveModeChannel, type ModeChannel } from "../../lib/modeChannel";
import { THINKING_DISPLAY_LABELS, THINKING_DISPLAYS, type ThinkingDisplay } from "../../lib/thinkingDisplay";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { BRAND_BUTTON, ConfirmButton, Dialog } from "../Dialog";
import { composerStatusText, type ComposerStatusParts } from "./composerStatus";
import { LaunchOptionRestartDialog } from "./LaunchOptionRestartDialog";
import { SessionConfigControls } from "./SessionConfigControls";

interface Props {
  sessionId: string;
  currentAgent: AcpState["agent"];
  yoloMode: boolean;
  availableModes: AcpState["availableModes"];
  currentModeId: string | null;
  legacyMode: AcpState["mode"];
  configOptions: AcpState["configOptions"];
  pendingConfigOption: AcpState["pendingConfigOption"];
  setConfigOption: (configId: string, value: string) => void | Promise<void>;
  /** Read-only one-line summary shown on the chip. */
  summary: ComposerStatusParts;
}

/** The permission segment is tinted by mode id so destructive modes stand out without opening the dialog. */
const MODE_TONES: [RegExp, string][] = [
  [/bypass|yolo/i, "text-rose-300"],
  [/accept/i, "text-amber-300"],
  [/plan/i, "text-cyan-300"],
];

/** Whether SessionConfigControls has anything to render. */
function hasSessionConfigControls(configOptions: AcpState["configOptions"]): boolean {
  return configOptions.some((option) => option.category === "model" || option.category === "thought_level");
}

/** Legacy `session/set_mode`; success arrives as a CurrentModeChanged broadcast. */
async function postLegacyMode(sessionId: string, id: string): Promise<void> {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode_id: id }),
    });
  } catch {
    // On failure the UI simply stays on the current mode.
  }
}

export function SessionSettingsControl(props: Props) {
  const profile = useAgentProfile();
  const [open, setOpen] = useState(false);
  const [launchChange, setLaunchChange] = useState<{ option: AgentLaunchOption; enabled: boolean } | null>(null);
  // Each channel (config option, SessionModeState, claude fallback) pairs with its own write path.
  const channel = resolveModeChannel({
    configOptions: props.configOptions,
    availableModes: props.availableModes,
    currentModeId: props.currentModeId,
    legacyMode: props.legacyMode,
    pendingConfigOption: props.pendingConfigOption,
    allowLegacyFallback: profile.capabilities.legacyModeFallback,
  });
  const launchOptions = agentLaunchOptions(props.currentAgent ?? profile.key, props.yoloMode);

  if (!channel && launchOptions.length === 0 && !hasSessionConfigControls(props.configOptions)) return null;
  const activeToneId = props.yoloMode ? "yolo" : (channel?.activeId ?? "");
  const permissionTone = MODE_TONES.find(([re]) => re.test(activeToneId))?.[1];
  const summaryText = composerStatusText(props.summary);

  const selectMode = (id: string) => {
    if (!channel || id === channel.activeId || id === channel.pendingId) return;
    if (channel.kind === "config") void props.setConfigOption(channel.configId, id);
    else void postLegacyMode(props.sessionId, id);
  };

  return (
    <>
      <button
        type="button"
        {...tourAnchor(TOUR_ANCHORS.sessionSettings)}
        data-testid="session-settings-trigger"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        title={`Session settings: ${summaryText}`}
        aria-label={`Session settings: ${summaryText}`}
        // Narrow footers truncate the chip on the toolbar's line instead of wrapping it onto its own.
        className={[
          "inline-flex min-w-0 max-w-full flex-1 basis-0 items-center gap-1.5 sm:flex-none sm:basis-auto",
          "rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-[11px] font-medium text-text-secondary",
          "transition-colors hover:border-surface-600",
        ].join(" ")}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <StatusSegments parts={props.summary} permissionTone={permissionTone} />
        </span>
        <Settings2 className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && (
        <SessionSettingsDialog
          sessionId={props.sessionId}
          channel={channel}
          onSelectMode={selectMode}
          configOptions={props.configOptions}
          pendingConfigOption={props.pendingConfigOption}
          setConfigOption={props.setConfigOption}
          launchOptions={launchOptions}
          onToggleLaunchOption={(option) => {
            setOpen(false);
            setLaunchChange({ option, enabled: !option.enabled });
          }}
          onClose={() => setOpen(false)}
        />
      )}
      {launchChange && (
        <LaunchOptionRestartDialog
          optionName={launchChange.option.name}
          enabled={launchChange.enabled}
          warning={launchChange.option.warning}
          onCancel={() => setLaunchChange(null)}
          onConfirm={async () => {
            await updateAgentLaunchOptions(props.sessionId, { yolo_mode: launchChange.enabled });
            setLaunchChange(null);
          }}
        />
      )}
    </>
  );
}

function StatusSegments({ parts, permissionTone }: { parts: ComposerStatusParts; permissionTone?: string }) {
  const segments = [
    { key: "agent", text: parts.agent },
    { key: "permission", text: parts.permission, className: permissionTone },
    { key: "model", text: parts.model },
    { key: "effort", text: parts.effort },
  ].filter((segment) => segment.text);
  return segments.map((segment, index) => (
    <span key={segment.key}>
      {index > 0 && " · "}
      <span data-testid={`session-summary-${segment.key}`} className={segment.className}>
        {segment.text}
      </span>
    </span>
  ));
}

const DIALOG_ID = "session-settings-dialog";

function SessionSettingsDialog({
  sessionId,
  channel,
  onSelectMode,
  configOptions,
  pendingConfigOption,
  setConfigOption,
  launchOptions,
  onToggleLaunchOption,
  onClose,
}: {
  sessionId: string;
  channel: ModeChannel | null;
  onSelectMode: (id: string) => void;
  configOptions: AcpState["configOptions"];
  pendingConfigOption: AcpState["pendingConfigOption"];
  setConfigOption: (configId: string, value: string) => void | Promise<void>;
  launchOptions: AgentLaunchOption[];
  onToggleLaunchOption: (option: AgentLaunchOption) => void;
  onClose: () => void;
}) {
  const doneRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    doneRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open dropdown inside the dialog takes this Escape for itself.
      if (document.querySelector(`[data-testid="${DIALOG_ID}"] [role="menu"]`)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Dialog
      id={DIALOG_ID}
      title="Session settings"
      bodyClassName="flex flex-col gap-4 px-5 py-4"
      onDismiss={onClose}
      footer={
        <ConfirmButton buttonRef={doneRef} onClick={onClose} className={BRAND_BUTTON}>
          Done
        </ConfirmButton>
      }
    >
      {channel && (
        <Section label={channel.label}>
          <ModeOptions channel={channel} onSelect={onSelectMode} />
        </Section>
      )}
      {hasSessionConfigControls(configOptions) && (
        <Section label="Model and effort">
          <SessionConfigControls
            configOptions={configOptions}
            pendingConfigOption={pendingConfigOption}
            onSetConfigOption={setConfigOption}
          />
        </Section>
      )}
      <Section label="Thinking">
        <ThinkingDisplayOptions sessionId={sessionId} />
      </Section>
      {launchOptions.length > 0 && (
        <Section label="Launch options · restart required">
          <div className="flex flex-col">
            {launchOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="switch"
                aria-checked={option.enabled}
                onClick={() => onToggleLaunchOption(option)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-surface-700/40"
              >
                <span
                  className={[
                    "mt-0.5 inline-block h-3 w-3 shrink-0 rounded-sm border",
                    option.enabled ? "border-brand-500 bg-brand-500" : "border-surface-600",
                  ].join(" ")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-text-primary">{option.name}</span>
                  <span className="block text-[11px] text-text-dim">{option.description}</span>
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}
    </Dialog>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[10px] uppercase tracking-wider text-text-dim">{label}</h3>
      {children}
    </section>
  );
}

function ModeOptions({ channel, onSelect }: { channel: ModeChannel; onSelect: (id: string) => void }) {
  return (
    <div role="radiogroup" aria-label={channel.label} data-testid="session-mode-options" className="flex flex-col">
      {channel.modes.map((opt) => {
        const isPending = opt.id === channel.pendingId;
        const isActive = opt.id === channel.activeId;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={isPending}
            onClick={() => onSelect(opt.id)}
            className={[
              "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-surface-700/40",
              isActive ? "bg-surface-700/30" : "",
              isPending ? "cursor-not-allowed opacity-50" : "",
            ].join(" ")}
          >
            <span
              className={[
                "mt-0.5 inline-block h-3 w-3 shrink-0 rounded-full border",
                isActive ? "border-brand-500 bg-brand-500" : "border-surface-600",
              ].join(" ")}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-text-primary">{opt.name}</span>
              {opt.description && <span className="block text-[11px] text-text-dim">{opt.description}</span>}
            </span>
            {isPending && <span className="text-[10px] uppercase text-text-dim">…</span>}
          </button>
        );
      })}
    </div>
  );
}

const THINKING_CHOICES: readonly (ThinkingDisplay | "default")[] = ["default", ...THINKING_DISPLAYS];

/** Per-session override of the dashboard's thinking display; "Default" follows the dashboard. */
function ThinkingDisplayOptions({ sessionId }: { sessionId: string }) {
  const { override, globalDefault, setOverride } = useSessionThinkingDisplay(sessionId);
  const selected = override ?? "default";
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label="Thinking display"
        data-testid="thinking-display-options"
        className="inline-flex w-fit items-center gap-0.5 rounded-md border border-surface-700 bg-surface-800/60 p-0.5"
      >
        {THINKING_CHOICES.map((choice) => {
          const isCurrent = choice === selected;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={isCurrent}
              data-testid={`thinking-display-value-${choice}`}
              onClick={() => setOverride(choice === "default" ? null : choice)}
              className={[
                "rounded px-2 py-0.5 text-[11px] font-medium transition-colors",
                isCurrent ? "bg-surface-700 text-text-primary" : "text-text-secondary hover:text-text-primary",
              ].join(" ")}
            >
              {choice === "default" ? "Default" : THINKING_DISPLAY_LABELS[choice]}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-text-dim">
        Default follows your dashboard setting ({THINKING_DISPLAY_LABELS[globalDefault]}). Thinking is always recorded,
        so you can reveal it later.
      </p>
    </div>
  );
}
