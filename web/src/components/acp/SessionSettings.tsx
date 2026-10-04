// Session settings: a read-only summary chip in the composer footer that opens a
// dialog holding the agent's mode, model, effort, thinking display, and launch options.

import { ArrowLeftRight, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useSessionThinkingDisplay } from "../../hooks/useSessionThinkingDisplay";
import type { AcpState } from "../../lib/acpTypes";
import { agentLaunchOptions, updateAgentLaunchOptions, type AgentLaunchOption } from "../../lib/agentLaunchOptions";
import { useAgentProfile } from "../../lib/agentProfileContext";
import { resolveModeChannel, type ModeChannel } from "../../lib/modeChannel";
import { requestSwitchAgent } from "../../lib/switchAgentTrigger";
import { THINKING_DISPLAY_LABELS, THINKING_DISPLAYS, type ThinkingDisplay } from "../../lib/thinkingDisplay";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { BRAND_BUTTON, ConfirmButton, Dialog } from "../Dialog";
import { compactModelName, composerStatusText, type ComposerStatusParts } from "./composerStatus";
import { LaunchOptionRestartDialog } from "./LaunchOptionRestartDialog";
import { CompactionBudgetControl } from "./CompactionBudgetControl";
import { ChoiceDropdown, ConfigRow, SessionConfigControls } from "./SessionConfigControls";

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
        // Narrow footers right-align the chip and truncate it on the toolbar's
        // line instead of wrapping it onto its own.
        className={[
          "ml-auto inline-flex min-w-0 max-w-full flex-initial items-center gap-1.5 @lg:ml-0 @lg:flex-none",
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
          agent={props.summary.agent}
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

/** Below a wide footer the agent and the model's qualifier drop out; the title keeps both. */
function StatusSegments({ parts, permissionTone }: { parts: ComposerStatusParts; permissionTone?: string }) {
  const model = parts.model && compactModelName(parts.model);
  const segments = [
    { key: "agent", text: parts.agent, wideOnly: true },
    { key: "permission", text: parts.permission, className: permissionTone },
    {
      key: "model",
      text:
        model && model !== parts.model ? (
          <>
            <span className="@3xl:hidden">{model}</span>
            <span className="hidden @3xl:inline">{parts.model}</span>
          </>
        ) : (
          parts.model
        ),
    },
    { key: "effort", text: parts.effort },
  ].filter((segment) => segment.text);
  // Each separator trails its segment, so hiding the agent takes its separator with it.
  return segments.map((segment, index) => (
    <span key={segment.key} className={segment.wideOnly ? "hidden @3xl:inline" : undefined}>
      <span data-testid={`session-summary-${segment.key}`} className={segment.className}>
        {segment.text}
      </span>
      {index < segments.length - 1 && " · "}
    </span>
  ));
}

const DIALOG_ID = "session-settings-dialog";

function SessionSettingsDialog({
  sessionId,
  agent,
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
  agent: string;
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
      <Section label="Agent">
        <div className="flex items-center justify-between gap-3">
          <span data-testid="session-settings-agent" className="text-xs font-medium text-text-primary">
            {agent}
          </span>
          <button
            type="button"
            onClick={() => {
              onClose();
              requestSwitchAgent(sessionId);
            }}
            className={[
              "inline-flex items-center gap-1 rounded-md border border-surface-700 bg-surface-800/60 px-2 py-1 text-[11px] font-medium",
              "text-text-secondary transition-colors hover:border-brand-600/60 hover:text-text-primary",
            ].join(" ")}
          >
            <ArrowLeftRight className="h-3 w-3 opacity-70" aria-hidden />
            Switch agent…
          </button>
        </div>
      </Section>
      <Section label="Session">
        <div className="flex flex-col gap-2">
          {channel && (
            <ConfigRow label={channel.label}>
              <ChoiceDropdown
                label={channel.label}
                choices={channel.modes.map((mode) => ({
                  value: mode.id,
                  name: mode.name,
                  description: mode.description,
                }))}
                current={channel.activeId}
                pending={channel.pendingId}
                onSelect={onSelectMode}
                testId="session-mode"
              />
            </ConfigRow>
          )}
          {hasSessionConfigControls(configOptions) && (
            <SessionConfigControls
              configOptions={configOptions}
              pendingConfigOption={pendingConfigOption}
              onSetConfigOption={setConfigOption}
            />
          )}
          <ThinkingDisplayRow sessionId={sessionId} />
        </div>
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
      <CompactionBudgetControl key={sessionId} sessionId={sessionId} />
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

const THINKING_CHOICES: readonly (ThinkingDisplay | "default")[] = ["default", ...THINKING_DISPLAYS];

/** Per-session override of the dashboard's thinking display; "Default" follows the dashboard. */
function ThinkingDisplayRow({ sessionId }: { sessionId: string }) {
  const { override, globalDefault, setOverride } = useSessionThinkingDisplay(sessionId);
  return (
    <ConfigRow label="Thinking">
      <ChoiceDropdown
        label="Thinking"
        note="Thinking is always recorded, so you can reveal it later."
        choices={THINKING_CHOICES.map((choice) => ({
          value: choice,
          name:
            choice === "default"
              ? `Default (${THINKING_DISPLAY_LABELS[globalDefault]})`
              : THINKING_DISPLAY_LABELS[choice],
          description: choice === "default" ? "Follows your dashboard setting" : null,
        }))}
        current={override ?? "default"}
        onSelect={(choice) => setOverride(choice === "default" ? null : (choice as ThinkingDisplay))}
        testId="thinking-display"
      />
    </ConfigRow>
  );
}
