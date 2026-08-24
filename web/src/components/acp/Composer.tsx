// Structured view composer: assistant-ui's ComposerPrimitive with `@` file and
// `/` command trigger popovers, attachments, queue recall, and draft persistence.

import { ComposerPrimitive } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter as defaultDirectiveFormatter } from "@assistant-ui/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AtSign, Paperclip, Pencil, Slash } from "lucide-react";

import { useFocusTerminalTarget } from "../../hooks/useFocusTerminalTarget";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { useSkillIndex } from "../../hooks/useSkillIndex";
import { clearDraft, clearDraftAttachments } from "../../lib/acpDrafts";
import type { AcpState, PromptAttachmentInput, PromptCapabilities, QueuedPrompt } from "../../lib/acpTypes";
import { useAgentProfile } from "../../lib/agentProfileContext";
import { resolveModeChannel } from "../../lib/modeChannel";
import { isIOS, isStandalone } from "../../lib/platform";
import { sessionEntries } from "../../lib/pluginUi";
import { usePluginUiEntries } from "../../lib/pluginUiContext";
import {
  clearPendingSwitchAgent,
  getPendingSwitchAgent,
  subscribePendingSwitchAgent,
} from "../../lib/switchAgentTrigger";
import { TOUR_ANCHORS, tourAnchor } from "../../lib/tourSteps";
import { PluginComposerActions } from "../plugin/PluginSlots";
import { composerDraftOperation, type ComposerDraftOperation } from "../plugin/composerDraftOperation";
import {
  AttachmentChips,
  ModePicker,
  PopoverItems,
  QueueSendButton,
  SendButton,
  StopButton,
  ToolbarButton,
  UsageHint,
} from "./ComposerControls";
import {
  acceptForCaps,
  composerWrapperLayout,
  decideArrowRecall,
  decideBeforeInputAction,
  decideEnterAction,
  fitTextarea,
  insertAtCaret,
  insertNewlineAtCaret,
  insertRawTextAtCaret,
  insertSlashCommand,
  IOS_ACCESSORY_BAR_PX,
} from "./composerInput";
import { SessionConfigControls } from "./SessionConfigControls";
import { SwitchAgentModal } from "./SwitchAgentModal";
import {
  useAttachments,
  useComposerClient,
  useDraftPersistence,
  useIsMobileInput,
  useLoadText,
  useQueueRecall,
  useTriggerAdapters,
  type ComposerClient,
} from "./useComposerHooks";
import { useDictationBurstGuard } from "./useDictationBurstGuard";
import type { ComposerAvailability } from "./status/conversationDiagnostics";

interface Props {
  sessionId: string;
  currentAgent: AcpState["agent"];
  yoloMode?: boolean;
  availableModes: AcpState["availableModes"];
  currentModeId: AcpState["currentModeId"];
  /** Fallback when the agent advertises no modes. */
  legacyMode: AcpState["mode"];
  configOptions: AcpState["configOptions"];
  pendingConfigOption: AcpState["pendingConfigOption"];
  setConfigOption: (configId: string, value: string) => void | Promise<void>;
  sessionUsage: AcpState["sessionUsage"];
  availableCommands: AcpState["availableCommands"];
  /** Shared policy for what submitting the current draft means. */
  availability: Exclude<ComposerAvailability, { kind: "read_only" }>;
  /** Mid-turn the textarea stays editable and sends go through the queue. */
  turnActive: boolean;
  /** Queue path used by the custom send buttons and mid-turn Enter, which the primitive blocks. */
  enqueuePrompt: (text: string, attachments?: PromptAttachmentInput[]) => void | Promise<void>;
  promptCapabilities: PromptCapabilities | null;
  /** Owned by AcpRuntime so the idle Enter path can read them on submit. */
  pendingAttachments: PromptAttachmentInput[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<PromptAttachmentInput[]>>;
  /** Replaces the text and focuses; a fresh `id` re-applies the same text. */
  primerPrefill?: { id: string; text: string } | null;
  /** Oldest first; source for ArrowUp/ArrowDown recall. */
  queuedPrompts: QueuedPrompt[];
  editQueuedPrompt: (id: string, text: string) => void;
}

const POPOVER_CLASS =
  "absolute bottom-full left-0 right-0 mb-2 z-30 overflow-hidden rounded-lg border border-surface-700 bg-surface-850 shadow-xl";

export function Composer(props: Props) {
  const { sessionId, turnActive, availability, promptCapabilities, queuedPrompts } = props;
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLFormElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { client, composerText, draftTextRef } = useComposerClient();
  const loadText = useLoadText(client, taRef);
  const attachments = useAttachments(promptCapabilities, props.pendingAttachments, props.setPendingAttachments);
  const { fileAdapter, slashAdapter } = useTriggerAdapters(sessionId, props.availableCommands);
  const skillIndex = useSkillIndex();
  const isMobile = useIsMobileInput();
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const { keyboardOpen } = useMobileKeyboard();
  // Regular iOS Safari already lifts the composer by keyboardHeight; only the PWA needs this.
  const iosPwa = useMemo(() => isIOS() && isStandalone(), []);
  const recall = useQueueRecall(queuedPrompts, client, loadText);
  const canSend = composerText.trim().length > 0 || attachments.supported.length > 0;
  const submissionBlocked = availability.kind === "blocked";

  const submitComposer = useCallback(() => {
    if (submissionBlocked) return;
    if (attachments.preparingRef.current > 0) return;
    const cur = recall.recallRef.current;
    if (cur) {
      recall.applyRecall(null);
      const text = client.getState().text.trim();
      // Submitting while browsing edits in place; if the entry drained, send normally so nothing is lost.
      if (text && queuedPrompts.some((p) => p.id === cur.id)) {
        props.editQueuedPrompt(cur.id, text);
        client.setText("");
        if (taRef.current) taRef.current.style.height = "auto";
        return;
      }
    }
    sendFromTextarea(taRef, client, props.enqueuePrompt, sessionId, attachments.supported, () =>
      props.setPendingAttachments([]),
    );
  }, [client, props, sessionId, attachments, queuedPrompts, recall, submissionBlocked]);

  usePluginDraftOperations(sessionId, client, taRef);
  usePrimerPrefill(props.primerPrefill, loadText);
  useDraftPersistence(sessionId, client, composerText, draftTextRef, taRef);
  useInitialFocus(isMobile, taRef);
  // Sidebar session selection focuses the composer even when already mounted.
  useFocusTerminalTarget("composer", taRef);

  // Opened from the sidebar row's "Switch agent" item.
  const pendingSwitchAgentSessionId = useSyncExternalStore(
    subscribePendingSwitchAgent,
    getPendingSwitchAgent,
    () => null,
  );
  const dictationGuard = useDictationBurstGuard((text) => client.setText(text));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc while browsing restores the draft, ahead of the primitive's own Escape handling.
    if (e.key === "Escape" && recall.recallRef.current != null) {
      e.preventDefault();
      e.stopPropagation();
      recall.cancelToDraft();
      return;
    }
    const el = taRef.current;
    const keys = {
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
    };
    const recallAction = decideArrowRecall(keys, {
      caretAtStart: !!el && el.selectionStart === 0 && el.selectionEnd === 0,
      browsing: recall.recallRef.current != null,
      queueLen: queuedPrompts.length,
    });
    if (recallAction !== "default") {
      e.preventDefault();
      e.stopPropagation();
      recall.recall(recallAction);
      return;
    }
    if (
      submissionBlocked &&
      !isMobile &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (decideEnterAction(keys, { isMobile, turnActive }) === "default") return;
    e.preventDefault();
    e.stopPropagation();
    submitComposer();
  };

  const wrapperLayout = composerWrapperLayout({ keyboardOpen, accessoryBarPx: iosPwa ? IOS_ACCESSORY_BAR_PX : 0 });
  const profile = useAgentProfile();
  const modeChannel = resolveModeChannel({
    configOptions: props.configOptions,
    availableModes: props.availableModes,
    currentModeId: props.currentModeId,
    legacyMode: props.legacyMode,
    pendingConfigOption: props.pendingConfigOption,
    allowLegacyFallback: profile.capabilities.legacyModeFallback,
  });
  const activeMode = modeChannel?.modes.find((mode) => mode.id === modeChannel.activeId)?.name;
  const summary = composerStatusSummary({
    agent: props.currentAgent ?? profile.key,
    mode: activeMode,
    yoloMode: props.yoloMode ?? false,
    configOptions: props.configOptions,
  });
  const hasDraft = composerText.trim().length > 0 || attachments.supported.length > 0;
  const expandMobileComposer = () => {
    setMobileExpanded(true);
    requestAnimationFrame(() => taRef.current?.focus());
  };
  return (
    <div className={wrapperLayout.className} style={wrapperLayout.style}>
      <div
        {...tourAnchor(TOUR_ANCHORS.composer)}
        className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl"
        onDragOver={(e) => {
          if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          const dropped = e.dataTransfer?.files;
          if (!dropped || dropped.length === 0) return;
          e.preventDefault();
          if (attachments.enabled) void attachments.addFiles(dropped);
        }}
      >
        <ComposerPrimitive.Unstable_TriggerPopoverRoot>
          <ComposerPrimitive.Root
            ref={rootRef}
            data-testid="composer-root"
            className={[
              "group relative flex flex-col gap-2 rounded-xl border border-surface-700 bg-surface-850",
              "shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
              "focus-within:border-brand-600/70 focus-within:shadow-[inset_0_1px_0_rgba(255,255,255,0.02),0_0_0_3px_rgba(217,119,6,0.12)]",
              "transition-colors duration-150",
            ].join(" ")}
            onBlurCapture={() => {
              requestAnimationFrame(() => {
                if (!rootRef.current?.contains(document.activeElement)) setMobileExpanded(false);
              });
            }}
          >
            {!mobileExpanded && (
              <div
                data-testid="composer-mobile-status"
                className="flex min-h-8 min-w-0 items-center gap-2 px-2 py-1 sm:hidden"
              >
                <button
                  type="button"
                  onClick={expandMobileComposer}
                  title={`Open message composer. ${summary}`}
                  aria-label={`Open message composer. ${summary}`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <Pencil
                    data-testid="composer-mobile-compose-icon"
                    className="h-3.5 w-3.5 shrink-0 text-brand-400"
                    aria-hidden
                  />
                  <span className="h-3 shrink-0 border-l border-surface-700/60" aria-hidden />
                  <span className="min-w-0 truncate text-[10px] font-medium text-text-secondary">
                    {hasDraft && <span className="mr-1.5 text-brand-400">Draft ·</span>}
                    {attachments.supported.length > 0 && (
                      <span className="mr-1.5 text-brand-400">
                        {attachments.supported.length} file{attachments.supported.length === 1 ? "" : "s"} ·
                      </span>
                    )}
                    {summary}
                  </span>
                </button>
                {queuedPrompts.length > 0 && (
                  <span
                    data-testid="composer-mobile-queued-count"
                    className="shrink-0 text-[10px] font-medium tabular-nums text-sky-400"
                    title={`${queuedPrompts.length} queued follow-up${queuedPrompts.length === 1 ? "" : "s"}`}
                  >
                    Q{queuedPrompts.length}
                  </span>
                )}
                <div className="shrink-0">
                  <UsageHint usage={props.sessionUsage} />
                </div>
                {turnActive && <StopButton compact />}
              </div>
            )}

            {recall.recallInfo && (
              <div
                className={`${mobileExpanded ? "flex" : "hidden sm:flex"} items-center justify-between gap-2 rounded-t-lg border-b border-surface-700 bg-surface-800 px-3 py-1.5 text-xs text-text-secondary`}
              >
                <span className="flex items-center gap-1.5 font-medium text-text-primary">
                  <Pencil className="h-3.5 w-3.5 text-brand-400" />
                  Editing queued message {recall.recallInfo.pos} of {recall.recallInfo.total}
                </span>
                <span className="text-text-dim">Enter saves · Esc restores draft · ↑ ↓ to browse</span>
              </div>
            )}

            <ComposerPrimitive.Unstable_TriggerPopover char="@" adapter={fileAdapter} className={POPOVER_CLASS}>
              <ComposerPrimitive.Unstable_TriggerPopover.Directive formatter={defaultDirectiveFormatter} />
              <PopoverItems trigger="@" />
            </ComposerPrimitive.Unstable_TriggerPopover>

            <ComposerPrimitive.Unstable_TriggerPopover char="/" adapter={slashAdapter} className={POPOVER_CLASS}>
              <ComposerPrimitive.Unstable_TriggerPopover.Action
                onExecute={(item) => insertSlashCommand(taRef, item)}
                removeOnExecute
              />
              <PopoverItems trigger="/" skillIndex={skillIndex} />
            </ComposerPrimitive.Unstable_TriggerPopover>

            <ComposerPrimitive.Input
              ref={taRef}
              rows={2}
              // Touch-primary Enter inserts a newline; sending is the Send button's job.
              unstable_insertNewlineOnTouchEnter
              // Cancel stays behind the Stop button; a stray Escape must not abort a turn.
              cancelOnEscape={false}
              placeholder={
                turnActive
                  ? availability.kind === "steer_now"
                    ? "Add to the current turn… (the agent picks it up mid-work)"
                    : "Queue a follow-up… (sent when current turn ends)"
                  : availability.kind === "blocked"
                    ? "Sending is unavailable; your draft will be preserved"
                    : availability.kind === "wake_agent"
                      ? "Send a message… (wakes the dormant agent)"
                      : "Send a message…  Type @ for files, / for commands"
              }
              onInput={(e) => fitTextarea(e.currentTarget)}
              onFocus={() => {
                // Belt and braces for UAs that lag the keyboard's layout-viewport update.
                if (!isMobile) return;
                window.setTimeout(() => {
                  taRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
                }, 300);
              }}
              onBeforeInput={(e) => {
                const ne = e.nativeEvent as InputEvent;
                if (decideBeforeInputAction(ne.inputType, ne.isComposing, { isMobile }) === "newline") {
                  e.preventDefault();
                  e.stopPropagation();
                  insertNewlineAtCaret(taRef);
                  return;
                }
                // Must run before the primitive's onChange calls setText.
                dictationGuard.observeInputType(ne.inputType, Date.now());
              }}
              onChange={(e) => {
                // defaultPrevented makes the primitive skip its controlled-value flush during dictation.
                if (dictationGuard.shouldSuppressUpstream(e.currentTarget.value)) e.preventDefault();
              }}
              // Flush dictation before a Send click reads the text.
              onBlur={() => dictationGuard.flushOnBlur()}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                if (!attachments.enabled) return;
                const files = Array.from(e.clipboardData?.items ?? [])
                  .filter((it) => it.kind === "file")
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => f != null);
                if (files.length === 0) return;
                e.preventDefault();
                void attachments.addFiles(files);
              }}
              autoFocus={!isMobile}
              className={[
                mobileExpanded ? "" : "hidden sm:block",
                "min-h-[56px] max-h-[200px] resize-none bg-transparent",
                "px-4 pt-3 pb-1 text-sm leading-6 text-text-primary",
                "placeholder:text-text-dim focus:outline-none",
              ].join(" ")}
            />

            <div className={mobileExpanded ? "block" : "hidden sm:block"}>
              <AttachmentChips attachments={attachments.supported} onRemove={attachments.remove} />
            </div>

            {/* The left cluster wraps rather than scrolls, which would clip the upward model dropdown. */}
            <div
              data-testid="composer-footer"
              className={`${mobileExpanded ? "flex" : "hidden sm:flex"} items-end gap-2 border-t border-surface-800/60 px-2 pb-2 pt-1.5`}
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5 gap-y-1">
                <ToolbarButton
                  icon={<AtSign className="h-3.5 w-3.5" />}
                  label="Add file context (@)"
                  hint="@"
                  onClick={() => insertAtCaret(taRef, "@")}
                />
                <ToolbarButton
                  icon={<Slash className="h-3.5 w-3.5" />}
                  label="Slash command (/)"
                  hint="/"
                  onClick={() => insertAtCaret(taRef, "/")}
                />
                <ToolbarButton
                  icon={<Paperclip className="h-3.5 w-3.5" />}
                  label={
                    attachments.enabled
                      ? "Attach files (image / audio / resource)"
                      : promptCapabilities
                        ? "This agent does not accept attachments"
                        : "Waiting for agent capabilities…"
                  }
                  disabled={!attachments.enabled}
                  onClick={() => fileInputRef.current?.click()}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={acceptForCaps(promptCapabilities)}
                  className="hidden"
                  onChange={(e) => {
                    const picked = e.target.files;
                    if (picked && picked.length > 0) void attachments.addFiles(picked);
                    // Reset so re-picking the same file fires onChange.
                    e.target.value = "";
                  }}
                />
                <span className="mx-1 h-4 w-px bg-surface-700" aria-hidden />
                <ModePicker
                  sessionId={sessionId}
                  currentAgent={props.currentAgent}
                  yoloMode={props.yoloMode ?? false}
                  availableModes={props.availableModes}
                  currentModeId={props.currentModeId}
                  legacyMode={props.legacyMode}
                  configOptions={props.configOptions}
                  pendingConfigOption={props.pendingConfigOption}
                  setConfigOption={props.setConfigOption}
                />
                <SessionConfigControls
                  configOptions={props.configOptions}
                  pendingConfigOption={props.pendingConfigOption}
                  onSetConfigOption={props.setConfigOption}
                />
              </div>

              <div data-testid="composer-actions" className="flex shrink-0 items-center gap-2">
                <UsageHint usage={props.sessionUsage} />
                <PluginComposerActions sessionId={sessionId} getSnapshot={() => pluginSnapshot(client, taRef)} />
                {turnActive ? (
                  <>
                    <StopButton />
                    <QueueSendButton
                      availability={availability}
                      disabled={submissionBlocked || !canSend || attachments.preparing}
                      preparing={attachments.preparing}
                      onSend={submitComposer}
                    />
                  </>
                ) : (
                  <SendButton
                    availability={availability}
                    disabled={submissionBlocked || !canSend || attachments.preparing}
                    preparing={attachments.preparing}
                    onSend={submitComposer}
                  />
                )}
              </div>
            </div>
          </ComposerPrimitive.Root>
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      </div>
      <SwitchAgentModal
        open={pendingSwitchAgentSessionId === sessionId}
        sessionId={sessionId}
        currentAgent={props.currentAgent}
        onClose={() => clearPendingSwitchAgent()}
        onPrefill={loadText}
        trigger="manual"
      />
    </div>
  );
}

function agentDisplayName(agent: string): string {
  const known: Record<string, string> = {
    claude: "Claude",
    "claude-code": "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    gemini: "Gemini",
  };
  return (
    known[agent] ??
    agent.replace(/(^|[-_ ])([a-z])/g, (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
  );
}

function compactModeName(mode: string): string {
  const parenthesised = mode.match(/^Agent \((.+)\)$/i);
  if (!parenthesised) return mode;
  const inner = parenthesised[1]!;
  return inner.charAt(0).toUpperCase() + inner.slice(1);
}

export function composerStatusSummary({
  agent,
  mode,
  yoloMode,
  configOptions,
}: {
  agent: string;
  mode?: string;
  yoloMode: boolean;
  configOptions: AcpState["configOptions"];
}): string {
  const currentLabel = (category: "model" | "thought_level") => {
    const option = configOptions.find((candidate) => candidate.category === category);
    return option?.options.find((candidate) => candidate.value === option.current_value)?.name ?? option?.current_value;
  };
  return [
    agentDisplayName(agent),
    mode ? compactModeName(mode) : null,
    yoloMode ? "Yolo" : null,
    currentLabel("model"),
    currentLabel("thought_level"),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function pluginSnapshot(client: ComposerClient, taRef: React.RefObject<HTMLTextAreaElement | null>) {
  const ta = taRef.current;
  const text = client.getState().text;
  return {
    text,
    selectionStart: ta?.selectionStart ?? text.length,
    selectionEnd: ta?.selectionEnd ?? ta?.selectionStart ?? text.length,
  };
}

/** Apply each plugin draft operation once, keyed by plugin, entry, and operation id. */
function usePluginDraftOperations(
  sessionId: string,
  client: ComposerClient,
  taRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  const apply = useCallback(
    (operation: ComposerDraftOperation) => {
      const ta = taRef.current;
      if (operation.kind === "set-text") {
        client.setText(operation.text);
        if (!ta) return;
        requestAnimationFrame(() => {
          const el = taRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(operation.text.length, operation.text.length);
          fitTextarea(el);
        });
      } else if (!ta) {
        client.setText(`${client.getState().text}${operation.text}`);
      } else {
        insertRawTextAtCaret(ta, operation.text, operation.kind === "replace-selection");
      }
    },
    [client, taRef],
  );
  const pluginUiEntries = usePluginUiEntries();
  const entries = useMemo(
    () => sessionEntries(pluginUiEntries, "composer-action", sessionId),
    [pluginUiEntries, sessionId],
  );
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const entry of entries) {
      const draft = composerDraftOperation(entry);
      if (!draft) continue;
      const key = `${entry.plugin_id}:${entry.id}:${draft.id}`;
      if (seenRef.current.has(key)) continue;
      seenRef.current.add(key);
      apply(draft.operation);
    }
  }, [apply, entries]);
}

/** Load the primer text whenever a new prefill id arrives. */
function usePrimerPrefill(primerPrefill: Props["primerPrefill"], loadText: (text: string) => void) {
  const primerId = primerPrefill?.id ?? null;
  const primerText = primerPrefill?.text ?? null;
  // Mirrored into refs so the effect keys on the id alone.
  const primerIdRef = useRef(primerId);
  const primerTextRef = useRef(primerText);
  useEffect(() => {
    primerIdRef.current = primerId;
    primerTextRef.current = primerText;
  }, [primerId, primerText]);
  useEffect(() => {
    if (!primerIdRef.current || primerTextRef.current == null) return;
    loadText(primerTextRef.current);
  }, [loadText, primerId]);
}

/** Desktop only (focus pops the soft keyboard on mobile): focus on mount and
 *  reclaim briefly if focus fell back to body. */
function useInitialFocus(isMobile: boolean, taRef: React.RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    if (isMobile) return;
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const reclaim = () => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body || active === el) el.focus();
    };
    const timers = [window.setTimeout(reclaim, 250), window.setTimeout(reclaim, 700)];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [isMobile, taRef]);
}

/** Send text and staged attachments through the queue, then clear the composer.
 *  The persisted draft clears synchronously so a racing remount cannot restore it. */
function sendFromTextarea(
  taRef: React.RefObject<HTMLTextAreaElement | null>,
  client: ComposerClient,
  enqueuePrompt: Props["enqueuePrompt"],
  sessionId: string,
  attachments: PromptAttachmentInput[],
  clearAttachments: () => void,
): void {
  const text = client.getState().text.trim();
  if (!text && attachments.length === 0) return;
  void enqueuePrompt(text, attachments.length > 0 ? attachments : undefined);
  client.setText("");
  clearDraft(sessionId);
  clearDraftAttachments(sessionId);
  clearAttachments();
  if (taRef.current) taRef.current.style.height = "auto";
}
