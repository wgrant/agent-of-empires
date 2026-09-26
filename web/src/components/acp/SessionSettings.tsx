// Session settings: a read-only summary chip in the composer footer that opens a
// dialog holding the agent's mode, model, effort, and launch options.

import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AcpState } from "../../lib/acpTypes";
import { agentLaunchOptions, updateAgentLaunchOptions, type AgentLaunchOption } from "../../lib/agentLaunchOptions";
import { useAgentProfile } from "../../lib/agentProfileContext";
import { resolveModeChannel, type ModeChannel } from "../../lib/modeChannel";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { BRAND_BUTTON, ConfirmButton, Dialog } from "../Dialog";
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
  summary: string;
}

/** Chips tinted by mode id so destructive modes stand out without opening the dialog. */
const MODE_TONES: [RegExp, string][] = [
  [/bypass|yolo/i, "border-rose-700/50 bg-rose-950/30 text-rose-300 hover:border-rose-700"],
  [/accept/i, "border-amber-700/50 bg-amber-950/30 text-amber-300 hover:border-amber-700"],
  [/plan/i, "border-cyan-800/50 bg-cyan-950/30 text-cyan-300 hover:border-cyan-700"],
];
const DEFAULT_MODE_TONE = "border-surface-700 bg-surface-800 text-text-secondary hover:border-surface-600";

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
  const tone = MODE_TONES.find(([re]) => re.test(activeToneId))?.[1] ?? DEFAULT_MODE_TONE;

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
        title={`Session settings: ${props.summary}`}
        aria-label={`Session settings: ${props.summary}`}
        className={[
          "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
          "transition-colors",
          tone,
        ].join(" ")}
      >
        <span className="min-w-0 truncate">{props.summary}</span>
        <Settings2 className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
      </button>
      {open && (
        <SessionSettingsDialog
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

const DIALOG_ID = "session-settings-dialog";

function SessionSettingsDialog({
  channel,
  onSelectMode,
  configOptions,
  pendingConfigOption,
  setConfigOption,
  launchOptions,
  onToggleLaunchOption,
  onClose,
}: {
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
