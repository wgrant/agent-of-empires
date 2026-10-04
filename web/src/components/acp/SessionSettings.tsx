// Session settings: a read-only summary chip in the composer footer that opens a
// dialog holding the agent's mode, model, effort, thinking display, and launch options.

import { ArrowLeftRight, Clock3, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useSessionThinkingDisplay } from "../../hooks/useSessionThinkingDisplay";
import { useAgentSettings } from "../../hooks/useAgentSettings";
import type { AcpState } from "../../lib/acpTypes";
import { agentLaunchOptions, type AgentLaunchOption } from "../../lib/agentLaunchOptions";
import {
  applicationText,
  pendingAgentSettings,
  type AgentSettingsSnapshot,
  type AgentSettingsPatch,
  type PendingSetting,
} from "../../lib/agentSettings";
import { useAgentProfile } from "../../lib/agentProfileContext";
import { resolveModeChannel, type ModeChannel } from "../../lib/modeChannel";
import { requestSwitchAgent } from "../../lib/switchAgentTrigger";
import { THINKING_DISPLAY_LABELS, THINKING_DISPLAYS, type ThinkingDisplay } from "../../lib/thinkingDisplay";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { BRAND_BUTTON, Dialog } from "../Dialog";
import { compactModelName, composerStatusText, type ComposerStatusParts } from "./composerStatus";
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
  configOptionSwitchFailed?: AcpState["configOptionSwitchFailed"];
  modeSwitchFailed?: AcpState["modeSwitchFailed"];
  settings: ReturnType<typeof useAgentSettings>;
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

export function SessionSettingsControl(props: Props) {
  const profile = useAgentProfile();
  const [open, setOpen] = useState(false);
  const settings = props.settings;
  const snapshot = settings.snapshot;
  const pending = snapshot
    ? pendingAgentSettings(
        snapshot,
        props.configOptions,
        props.currentModeId,
        props.configOptionSwitchFailed,
        props.modeSwitchFailed,
        settings.launchIntent,
      )
    : [];
  const options = props.configOptions.length ? props.configOptions : (snapshot?.config_options ?? []);
  // Each channel (config option, SessionModeState, claude fallback) pairs with its own write path.
  const channel = resolveModeChannel({
    configOptions: options,
    availableModes: props.availableModes,
    currentModeId: props.currentModeId,
    legacyMode: props.legacyMode,
    pendingConfigOption: props.pendingConfigOption,
    allowLegacyFallback: profile.capabilities.legacyModeFallback,
  });
  const launchOptions = agentLaunchOptions(
    props.currentAgent ?? profile.key,
    snapshot?.yolo_mode.enabled ?? props.yoloMode,
  );

  const activeYolo = snapshot?.yolo_mode.applied_known ? snapshot.yolo_mode.applied_enabled : false;
  const activeToneId = activeYolo ? "yolo" : (channel?.activeId ?? "");
  const permissionTone = MODE_TONES.find(([re]) => re.test(activeToneId))?.[1];
  const summary =
    snapshot?.agent === "opencode"
      ? {
          ...props.summary,
          permission: snapshot.running
            ? snapshot.yolo_mode.applied_known
              ? snapshot.yolo_mode.applied_enabled
                ? "Yolo"
                : (channel?.activeId ?? "Approvals")
              : "Permissions unknown"
            : "Next start",
        }
      : props.summary;
  const summaryText = composerStatusText(summary);
  const label = `Session settings: ${summaryText}${pending.length ? `. ${pending.length} settings pending` : ""}`;

  return (
    <>
      <button
        type="button"
        {...tourAnchor(TOUR_ANCHORS.sessionSettings)}
        data-testid="session-settings-trigger"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        // Narrow footers right-align the chip and truncate it on the toolbar's
        // line instead of wrapping it onto its own.
        className={[
          "ml-auto inline-flex min-w-0 max-w-full flex-initial items-center gap-1.5 @lg:ml-0 @lg:flex-none",
          "rounded-md border border-surface-700 bg-surface-800 px-2 py-1 text-[11px] font-medium text-text-secondary",
          "transition-colors hover:border-surface-600",
        ].join(" ")}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <StatusSegments parts={summary} permissionTone={permissionTone} />
        </span>
        <Settings2 className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
        {pending.length > 0 && (
          <Clock3 data-testid="session-settings-pending" className="h-3 w-3 shrink-0 text-text-dim" aria-hidden />
        )}
      </button>
      {open && (
        <SessionSettingsDialog
          sessionId={props.sessionId}
          agent={props.summary.agent}
          channel={channel}
          configOptions={options}
          snapshot={snapshot}
          pending={pending}
          loadError={settings.error}
          save={settings.save}
          launchOptions={launchOptions}
          onClose={() => setOpen(false)}
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
  configOptions,
  snapshot,
  pending,
  loadError,
  save,
  launchOptions,
  onClose,
}: {
  sessionId: string;
  agent: string;
  channel: ModeChannel | null;
  configOptions: AcpState["configOptions"];
  snapshot: AgentSettingsSnapshot | null;
  pending: PendingSetting[];
  loadError: string | null;
  save: (patch: AgentSettingsPatch) => Promise<void>;
  launchOptions: AgentLaunchOption[];
  onClose: () => void;
}) {
  const doneRef = useRef<HTMLButtonElement | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [budgetDraft, setBudgetDraft] = useState<{ value: string | null } | null>(null);
  const [yoloDraft, setYoloDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const savedValue = (id: string, fallback: string) =>
    snapshot?.selectors.find((selector) => selector.config_id === id)?.value ?? fallback;
  const draftOptions = configOptions.map((option) => ({
    ...option,
    current_value: draft[option.id] ?? savedValue(option.id, option.current_value),
  }));
  const modeKey = channel?.kind === "config" ? channel.configId : "legacy_mode";
  const savedMode = channel
    ? channel.kind === "config"
      ? savedValue(channel.configId, channel.activeId)
      : (snapshot?.mode_id ?? channel.activeId)
    : "";
  const changedSelectors = Object.entries(draft).filter(
    ([id, value]) =>
      value !==
      (id === "legacy_mode"
        ? savedMode
        : savedValue(id, configOptions.find((option) => option.id === id)?.current_value ?? "")),
  );
  const budget = snapshot?.auto_compaction;
  const budgetValue = budgetDraft ? budgetDraft.value : (budget?.tokens?.toString() ?? null);
  const budgetChanged = budgetDraft !== null && budget != null && budgetValue !== (budget.tokens?.toString() ?? null);
  const yoloValue = yoloDraft ?? snapshot?.yolo_mode.enabled ?? launchOptions[0]?.enabled ?? false;
  const yoloChanged = yoloDraft !== null && yoloValue !== snapshot?.yolo_mode.enabled;
  const dirty = changedSelectors.length > 0 || budgetChanged || yoloChanged;
  const validBudget =
    budgetValue === null ||
    (budgetValue !== "" &&
      !!budget?.bounds &&
      Number.isSafeInteger(Number(budgetValue)) &&
      Number(budgetValue) >= budget.bounds[0] &&
      Number(budgetValue) <= budget.bounds[1]);
  const canRestart = snapshot?.running && (dirty || pending.length > 0);
  const dismiss = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const saveChanges = async (restart: boolean) => {
    const config = changedSelectors
      .filter(([id]) => id !== "legacy_mode")
      .map(([config_id, value]) => ({ config_id, value }));
    const mode = changedSelectors.find(([id]) => id === "legacy_mode")?.[1];
    const patch: AgentSettingsPatch = {
      ...(config.length > 0 && { config_options: config }),
      ...(mode !== undefined && { mode_id: mode }),
      ...(budgetChanged && { auto_compaction: { tokens: budgetValue === null ? null : Number(budgetValue) } }),
      ...(yoloChanged && { yolo_mode: yoloValue }),
      restart,
    };
    setSaving(true);
    setSaveError(null);
    try {
      await save(patch);
      setDraft({});
      setBudgetDraft(null);
      setYoloDraft(null);
      setConfirmRestart(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save agent settings");
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    doneRef.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(`[data-testid="${DIALOG_ID}"] [role="menu"]`)) return;
      if (!saving) {
        if (dirty) setConfirmDiscard(true);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirty, saving, onClose]);
  const button =
    "min-h-8 rounded-md border border-surface-700 px-2 py-1 text-xs text-text-secondary disabled:opacity-50";
  return (
    <Dialog
      id={DIALOG_ID}
      title="Session settings"
      bodyClassName="flex max-h-[65dvh] flex-col gap-4 overflow-y-auto px-5 py-4"
      onDismiss={dismiss}
      footer={
        <>
          {dirty && (
            <button type="button" className={button} disabled={saving} onClick={() => setConfirmDiscard(true)}>
              Discard…
            </button>
          )}
          <button
            type="button"
            ref={doneRef}
            className={`${button} ${dirty ? BRAND_BUTTON : ""}`}
            disabled={saving || (dirty && (!snapshot || !validBudget))}
            onClick={() => (dirty ? void saveChanges(false) : dismiss())}
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Close"}
          </button>
        </>
      }
    >
      <Section label="Agent">
        <div className="flex items-center justify-between gap-3">
          <span data-testid="session-settings-agent" className="text-xs font-medium text-text-primary">
            {agent}
          </span>
          <button
            type="button"
            disabled={dirty || saving}
            title={dirty ? "Save or discard changes before switching agents." : undefined}
            onClick={() => {
              onClose();
              requestSwitchAgent(sessionId);
            }}
            className={button}
          >
            <ArrowLeftRight className="mr-1 inline h-3 w-3 opacity-70" aria-hidden />
            Switch agent…
          </button>
        </div>
      </Section>
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <Section label="Agent settings">
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
                  current={draft[modeKey] ?? savedMode}
                  onSelect={(value) => setDraft((previous) => ({ ...previous, [modeKey]: value }))}
                  testId="session-mode"
                  selectedLabel="Selected"
                />
              </ConfigRow>
            )}
            {hasSessionConfigControls(draftOptions) && (
              <SessionConfigControls
                configOptions={draftOptions}
                pendingConfigOption={null}
                selectedLabel="Selected"
                onSetConfigOption={(id, value) => setDraft((previous) => ({ ...previous, [id]: value }))}
              />
            )}
            {launchOptions.map((option) => (
              <div key={option.id} className="flex flex-col gap-1">
                <button
                  type="button"
                  role="switch"
                  aria-checked={yoloValue}
                  onClick={() => setYoloDraft(!yoloValue)}
                  className="flex min-h-8 items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-surface-700/40"
                >
                  <span>{option.name}</span>
                  <span
                    className={`h-3 w-3 rounded-sm border ${yoloValue ? "border-brand-500 bg-brand-500" : "border-surface-600"}`}
                  />
                </button>
                <p className="text-[11px] text-text-dim">
                  {option.description}.{" "}
                  {snapshot?.running ? "Changes require a restart." : "Applies when the agent starts."}
                </p>
                {yoloChanged && yoloValue && <p className="text-[11px] text-status-warning">{option.warning}</p>}
              </div>
            ))}
            {budget && (
              <div className="flex flex-col gap-1">
                <CompactionBudgetControl
                  state={budget}
                  value={budgetValue}
                  disabled={saving}
                  onChange={(value) => setBudgetDraft({ value })}
                />
                {budget.bounds && (budgetChanged || pending.some((setting) => setting.id === "auto_compaction")) && (
                  <p className="text-[11px] text-text-dim">
                    {snapshot?.running ? "Changes require a restart." : "Applies when the agent starts."}
                  </p>
                )}
                {snapshot?.running && budget.bounds && !budget.applied_known && (
                  <p className="text-[11px] text-text-dim">The running agent’s compaction budget is unknown.</p>
                )}
              </div>
            )}
          </div>
        </Section>
        <Section label="Display">
          <ThinkingDisplayRow sessionId={sessionId} />
        </Section>
      </fieldset>
      {dirty && (
        <p role="status" className="text-xs text-text-dim">
          Unsaved changes.
        </p>
      )}
      {pending.length > 0 && (
        <section aria-label="Pending settings" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium text-text-primary">
            {pending.length} {pending.length === 1 ? "setting" : "settings"} pending
          </h3>
          {pending.map((setting) => (
            <p key={setting.id} className="text-text-dim">
              {setting.name}: {applicationText(setting.application)}
              {setting.reason ? `. ${setting.reason}` : ""}
            </p>
          ))}
        </section>
      )}
      {!snapshot && !loadError && <p className="text-xs text-text-dim">Loading agent settings…</p>}
      {[loadError, saveError].map(
        (error, index) =>
          error && (
            <p key={index} role="alert" className="text-xs text-status-error">
              {error}
            </p>
          ),
      )}
      {canRestart && !confirmRestart && (
        <button
          type="button"
          className={button}
          disabled={saving || !validBudget}
          onClick={() => setConfirmRestart(true)}
        >
          {dirty ? "Save and restart…" : "Restart agent…"}
        </button>
      )}
      {confirmRestart && (
        <section className="flex flex-col gap-2 text-xs">
          <p className="text-status-warning">
            Restarting interrupts any turn in progress. The conversation is retained.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={button}
              disabled={saving || !validBudget}
              onClick={() => void saveChanges(true)}
            >
              Restart agent
            </button>
            <button type="button" className={button} disabled={saving} onClick={() => setConfirmRestart(false)}>
              Cancel restart
            </button>
          </div>
        </section>
      )}
      {confirmDiscard && (
        <section className="flex flex-col gap-2 text-xs">
          <p className="text-status-warning">Discard unsaved agent settings? Display preferences are already saved.</p>
          <div className="flex gap-2">
            <button type="button" className={button} onClick={onClose}>
              Discard changes
            </button>
            <button type="button" className={button} onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
          </div>
        </section>
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
