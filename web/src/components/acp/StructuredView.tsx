/* eslint-disable react-refresh/only-export-components */
// Structured view conversation surface. assistant-ui renders the thread shell;
// state lives in AcpRuntime and is only fed to assistant-ui, never owned by it.

import { useLayoutEffect, useRef, useState } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { ChevronDown, RotateCcw } from "lucide-react";

import { useIsWideViewport } from "../../hooks/useIsWideViewport";
import { useConnectionIncidentVisibility } from "../../hooks/useConnectionIncidentVisibility";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { useWebSettings } from "../../hooks/useWebSettings";
import { useDashboardConnectionDiagnostics } from "../../lib/connectionState";
import { lastClearIndex } from "../../lib/acpHistoryWindow";
import { derivePromptOutbox } from "../../lib/acpPromptOutbox";
import { AgentProfileProvider } from "../../lib/agentProfileContext";
import { conversationFontSizeRem } from "../../lib/conversationFontSize";
import type { FileRef, FileRefSession } from "../../lib/fileRef";
import type { SessionStatus } from "../../lib/types";
import { topInsetScrollAdjustment } from "../../lib/historyScroll";
import { ChromeCollapseHandle, CollapsibleRegion } from "../CollapsibleChrome";
import { AcpFileRefContext } from "./AcpFileRefContext";
import { AcpRuntime, type AcpContext } from "./AcpRuntime";
import { ApprovalCard } from "./ApprovalCard";
import { AskUserQuestionCard } from "./AskUserQuestionCard";
import { AttentionChime } from "./AttentionChime";
import { BackgroundAgentsContext } from "./backgroundAgentsContext";
import { CompactionReminderBanner } from "./CompactionReminderBanner";
import { Composer } from "./Composer";
import { ContextPrimerBanner } from "./ContextPrimerBanner";
import { PlanStrip } from "./PlanStrip";
import { ModeSwitchFailedNotice, PromptOutboxPanel } from "./PromptStrips";
import { MonitoringBanner, ScheduledWakeupBanner, SessionBanners } from "./SessionBanners";
import { ConfigOptionSwitchFailedNotice } from "./SessionConfigControls";
import { StartupErrorScreen } from "./StartupErrorScreen";
import { deriveStructuredConnectionDiagnostics, SystemNotices } from "./SystemNotices";
import { ComposerActionRail } from "./status/ComposerActionRail";
import {
  selectConnectionDiagnostics,
  type ConnectionStatusSnapshot,
  type SessionConnectionDiagnostics,
  type StreamTransportDiagnostics,
} from "./status/connectionStatus";
import {
  deriveComposerAvailability,
  type ComposerAvailability,
  type ConversationDiagnosticsSnapshot,
} from "./status/conversationDiagnostics";
import { deriveConversationSyncStatus } from "./status/conversationSyncStatus";
import { deriveConversationNextStep } from "./status/conversationStatus";
import { deriveSessionDiagnostics, type PendingAgentOperation } from "./status/sessionDiagnostics";
import { AssistantMessage, UserMessage } from "./ThreadMessages";
import { ToolDensityToggle, ToolDisplayModeProvider, useToolDensityPref } from "./ToolDisplayMode";
import { useTranscriptScroll } from "./useTranscriptScroll";
import { WorkingSpinner } from "./WorkingSpinner";

type WorkerState = "absent" | "resuming" | "running" | "stopping";

interface Props {
  sessionId: string;
  /** `SessionResponse.acp_worker_state`, polled. */
  acpWorkerState: WorkerState;
  /** Whether rate-limit auto-resume is on for this session's profile. */
  rateLimitAutoResume?: boolean;
  /** Current server-owned session lifecycle, including restart reconciliation. */
  sessionStatus: SessionStatus;
  /** Durable lifecycle failure reported with the session record. */
  lastError?: string | null;
  /** Control request accepted by this browser but not yet corroborated by worker evidence. */
  pendingOperation?: PendingAgentOperation | null;
  /** An absent worker intentionally reaped for inactivity wakes on the next prompt. */
  dormant: boolean;
  /** Session `tool` registry key; selects the AgentProfile. */
  tool: string | null | undefined;
  /** Resolved ACP agent key; the switch-agent modal's fallback before any `AgentSwitched`. */
  acpAgent: string | null;
  /** Server-owned conversation-reset slash aliases (`/clear`, `/new`). */
  clearAliases?: readonly string[];
  yoloMode?: boolean;
  archivedAt: string | null;
  snoozedUntil: string | null;
  /** Trashed sessions are read-only: no composer or queue strips. */
  trashedAt: string | null;
  /** Restore the trashed workspace; resolves false on failure. */
  onRestore?: () => Promise<boolean> | void;
  onOpenFileRef?: (ref: FileRef) => void;
  fileRefSession?: FileRefSession | null;
  isSandboxed?: boolean;
  onOpenAgentsPane?: () => void;
}

const STARTER_PROMPTS = [
  "Explain this codebase",
  "Find recent changes worth reviewing",
  "What does the build pipeline do?",
];

export function StructuredView(props: Props) {
  const { sessionId, acpWorkerState, tool, clearAliases, archivedAt, snoozedUntil, onOpenFileRef, fileRefSession } =
    props;
  const [showClearedTurns, setShowClearedTurns] = useState(false);
  const [toolDensity, toggleToolDensity] = useToolDensityPref();
  return (
    <AcpFileRefContext.Provider value={{ onOpenFileRef, fileRefSession }}>
      <AgentProfileProvider toolKey={tool} clearAliases={clearAliases}>
        <ToolDisplayModeProvider density={toolDensity}>
          <AcpRuntime
            sessionId={sessionId}
            archivedAt={archivedAt}
            snoozedUntil={snoozedUntil}
            showClearedTurns={showClearedTurns}
          >
            {(ctx) => (
              <BackgroundAgentsContext.Provider
                value={{
                  agents: ctx.state.backgroundAgents,
                  openPane: props.onOpenAgentsPane,
                }}
              >
                <AcpChrome
                  view={props}
                  ctx={ctx}
                  showClearedTurns={showClearedTurns}
                  onToggleClearedTurns={() => setShowClearedTurns((v) => !v)}
                  toolDensity={toolDensity}
                  onToggleToolDensity={toggleToolDensity}
                />
              </BackgroundAgentsContext.Provider>
            )}
          </AcpRuntime>
        </ToolDisplayModeProvider>
      </AgentProfileProvider>
    </AcpFileRefContext.Provider>
  );
}

/** Bottom padding reserving the soft keyboard where the layout viewport does
 *  not shrink for it (iOS regular Safari); 0 elsewhere. */
export function structuredViewRootStyle(keyboardHeight: number): React.CSSProperties | undefined {
  return keyboardHeight > 0 ? { paddingBottom: keyboardHeight } : undefined;
}

/** Flex root publishing the keyboard reservation and both conversation font
 *  sizes (as rem); `index.css` picks the active size. */
export function StructuredViewRoot({ children }: { children: React.ReactNode }) {
  const { keyboardHeight } = useMobileKeyboard();
  const { settings } = useWebSettings();
  return (
    <div
      data-testid="structured-view-root"
      className="acp-conversation-scope flex h-full flex-col bg-surface-900 text-text-primary"
      style={
        {
          ...structuredViewRootStyle(keyboardHeight),
          "--acp-conversation-font-size-mobile": conversationFontSizeRem(settings.structuredMobileFontSize),
          "--acp-conversation-font-size-desktop": conversationFontSizeRem(settings.structuredDesktopFontSize),
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}

type Prefill = { id: string; text: string } | null;

interface ChromeProps {
  view: Props;
  ctx: AcpContext;
  showClearedTurns: boolean;
  onToggleClearedTurns: () => void;
  toolDensity: "detailed" | "compact";
  onToggleToolDensity: () => void;
}

function AcpChrome({
  view,
  ctx,
  showClearedTurns,
  onToggleClearedTurns,
  toolDensity,
  onToggleToolDensity,
}: ChromeProps) {
  const { sessionId, acpWorkerState, acpAgent } = view;
  const { state, status } = ctx;
  // Rows before the latest `/clear` divider are the hidden history.
  const hiddenCount = lastClearIndex(state.activity);
  const [primerPrefill, setPrimerPrefill] = useState<Prefill>(null);
  const sessionDiagnostics = deriveSessionDiagnostics({
    state,
    workerState: acpWorkerState,
    sessionStatus: view.sessionStatus,
    lastError: view.lastError ?? null,
    pendingOperation: view.pendingOperation ?? null,
    dormant: view.dormant,
    trashedAt: view.trashedAt,
    archivedAt: view.archivedAt,
    snoozedUntil: view.snoozedUntil,
  });
  const activeAgent = sessionDiagnostics.operational.kind === "active" ? sessionDiagnostics.operational.agent : null;
  const canSendQueuedNow = status === "open" && (activeAgent?.kind === "online" || activeAgent?.kind === "dormant");
  const sendNowInterruptsTurn =
    activeAgent?.kind === "online" &&
    (activeAgent.turn.kind === "cancelling" ||
      activeAgent.turn.kind === "compacting" ||
      ((activeAgent.turn.kind === "running" || activeAgent.turn.kind === "awaiting_user") && !activeAgent.canSteer));
  const connectionDiagnostics = deriveStructuredConnectionDiagnostics({
    status,
    serverReachability: ctx.serverReachability,
    lagged: state.lagged,
    rateLimit: state.rateLimit,
    rateLimitRetriesExhausted: state.rateLimitRetriesExhausted,
    hasEverOpened: ctx.hasEverOpened,
    reconnecting: ctx.reconnecting,
    retryCount: ctx.retryCount,
    retryCountdown: ctx.retryCountdown,
    maxRetries: ctx.maxRetries,
    agentRuntime: sessionDiagnostics.runtime,
    lastWebSocketOpenAt: ctx.lastWebSocketOpenAt,
    lastServerMessageAt: ctx.lastServerMessageAt,
    lastTransportDiagnostic: ctx.lastTransportDiagnostic,
    reconnectingSince: ctx.reconnectingSince,
    liveUpdatesStale: ctx.liveUpdatesStale,
  });
  const streamTransport: StreamTransportDiagnostics = {
    route: connectionDiagnostics.route,
    connectedAt: ctx.lastWebSocketOpenAt,
    lastMessageAt: ctx.lastServerMessageAt,
    reconnectingSince: ctx.reconnectingSince,
    retryCount: ctx.retryCount,
    retryCountdown: ctx.retryCountdown,
    maxRetries: ctx.maxRetries,
    lastFailure: ctx.lastTransportDiagnostic,
  };
  const sessionConnection: SessionConnectionDiagnostics = {
    kind: "structured",
    sessionId,
    operational: sessionDiagnostics.operational,
    diagnostics: connectionDiagnostics,
    transport: streamTransport,
  };
  const dashboardConnection = useDashboardConnectionDiagnostics();
  const connectionSnapshot: ConnectionStatusSnapshot = { dashboard: dashboardConnection, session: sessionConnection };
  const conversationDiagnostics: ConversationDiagnosticsSnapshot = {
    connection: connectionSnapshot,
    session: { sessionId, kind: "structured", lifecycle: sessionDiagnostics },
  };
  const composerAvailability = deriveComposerAvailability(conversationDiagnostics);
  const displayConnectionDiagnostics = selectConnectionDiagnostics(connectionSnapshot);
  const conversationSync = deriveConversationSyncStatus({
    replaySyncing: ctx.replaySyncing,
    hasEverOpened: ctx.hasEverOpened,
    loadingEarlier: ctx.loadingEarlierHistory,
    connectionStarting: status === "connecting",
  });
  const conversationNextStep = deriveConversationNextStep({
    sync: conversationSync,
    diagnostics: sessionDiagnostics,
  });
  const connectionIncidentVisible = useConnectionIncidentVisibility(sessionId, displayConnectionDiagnostics);
  const connectionInset = connectionIncidentVisible ? 44 : 0;
  const previousConnectionInsetRef = useRef(0);
  const pendingJumpToLatestRef = useRef(false);
  // Phone-width only: fold the composer away for reading.
  const composerCollapsible = !useIsWideViewport();
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const { viewportRef, belowViewportRef, messagesContentRef, atBottom, scrollToBottom, requestEarlierHistory } =
    useTranscriptScroll({
      sessionId,
      canLoadEarlierHistory: ctx.canLoadEarlierHistory,
      loadEarlierHistory: ctx.loadEarlierHistory,
      publishedTranscriptGeneration: ctx.publishedTranscriptGeneration,
      historyScrollAnchorRef: ctx.historyScrollAnchorRef,
      historyNavigationControllerRef: ctx.historyNavigationControllerRef,
      composerCollapsed,
      promptSeq: state.promptSeq,
      hasEverOpened: ctx.hasEverOpened,
      localInflight: state.inflightPromptIds.length > 0,
      liveTailRow: state.activity.at(-1),
    });
  const requestLatest = () => {
    if (ctx.canLoadNewerHistory) {
      pendingJumpToLatestRef.current = true;
      ctx.jumpToLatestHistory();
      return;
    }
    scrollToBottom();
  };
  useLayoutEffect(() => {
    if (!pendingJumpToLatestRef.current || ctx.canLoadNewerHistory) return;
    pendingJumpToLatestRef.current = false;
    requestAnimationFrame(scrollToBottom);
  }, [ctx.canLoadNewerHistory, scrollToBottom]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const previousInset = previousConnectionInsetRef.current;
    if (!viewport || previousInset === connectionInset) return;
    viewport.scrollTop += topInsetScrollAdjustment(previousInset, connectionInset, viewport.scrollTop);
    previousConnectionInsetRef.current = connectionInset;
  }, [connectionInset, viewportRef]);

  const connectionNotice = (
    <SystemNotices
      connectionSnapshot={connectionSnapshot}
      conversationSync={conversationSync}
      manualReconnect={ctx.manualReconnect}
      showConnectionIncident={connectionIncidentVisible}
    />
  );

  // An adapter that failed the compatibility check never runs, so no chat surface.
  if (state.incompatibleAgent) {
    return (
      <div className="flex h-full flex-col bg-surface-900 text-text-primary">
        <StartupErrorScreen detail={state.incompatibleAgent} sessionId={sessionId} isSandboxed={view.isSandboxed} />
      </div>
    );
  }
  return (
    <StructuredViewRoot>
      <AttentionChime approvals={state.pendingApprovals.length} elicitations={state.pendingElicitations.length} />
      <PlanStrip plan={state.plan} />

      <SessionBanners
        sessionId={sessionId}
        state={state}
        connectionSnapshot={connectionSnapshot}
        acpWorkerState={acpWorkerState}
        trashedAt={view.trashedAt}
        archivedAt={view.archivedAt}
        snoozedUntil={view.snoozedUntil}
        sessionStatus={view.sessionStatus}
        lastError={view.lastError ?? null}
        pendingOperation={view.pendingOperation ?? null}
        dormant={view.dormant}
        currentAgent={state.agent ?? acpAgent}
        rateLimitAutoResume={view.rateLimitAutoResume}
        onRecoveryPrefill={(text) => setPrimerPrefill({ id: `rate-limit-recovery-${Date.now()}`, text })}
        onRestore={view.onRestore}
        dismissError={ctx.dismissError}
      />

      <ThreadPrimitive.Root className="relative flex flex-1 flex-col min-h-0">
        {connectionNotice}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            autoScroll={false}
            scrollToBottomOnInitialize={false}
            scrollToBottomOnRunStart={false}
            scrollToBottomOnThreadSwitch={false}
            ref={viewportRef}
            data-testid="acp-viewport"
            className="flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
          >
            <div
              ref={messagesContentRef}
              className="mx-auto max-w-3xl px-4 pb-6 xl:max-w-4xl 2xl:max-w-5xl"
              style={{ paddingTop: `${24 + connectionInset}px` }}
            >
              <ThreadPrimitive.Empty>
                <EmptyState onPick={ctx.sendPrompt} />
              </ThreadPrimitive.Empty>

              {state.activity.length > 0 && (
                <div className="mb-2 flex">
                  <ToolDensityToggle density={toolDensity} onToggle={onToggleToolDensity} />
                </div>
              )}

              {hiddenCount > 0 && (
                <ClearedTurnsBanner
                  hiddenCount={hiddenCount}
                  expanded={showClearedTurns}
                  onToggle={onToggleClearedTurns}
                />
              )}

              {ctx.canLoadEarlierHistory && (
                <div className="mb-3 flex justify-center">
                  <button
                    type="button"
                    onClick={requestEarlierHistory}
                    disabled={ctx.loadingEarlierHistory}
                    data-testid="acp-load-earlier"
                    className="h-8 rounded-md border border-surface-700 bg-surface-800 px-3 text-xs text-text-secondary hover:bg-surface-700 hover:text-text-primary transition-colors cursor-pointer disabled:cursor-default disabled:opacity-60"
                  >
                    {ctx.loadingEarlierHistory ? "Loading…" : "Load earlier messages"}
                  </button>
                </div>
              )}

              <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />

              {ctx.canLoadNewerHistory && (
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={ctx.loadNewerHistory}
                    data-testid="acp-load-newer"
                    className="h-8 rounded-md border border-surface-700 bg-surface-800 px-3 text-xs text-text-secondary transition-colors hover:bg-surface-700 hover:text-text-primary"
                  >
                    Load newer messages
                  </button>
                </div>
              )}

              {conversationNextStep?.kind === "working" && (
                <div className="mt-3 ml-1">
                  <WorkingSpinner
                    thinking={conversationNextStep.thinking}
                    tool={conversationNextStep.tool}
                    cancelling={conversationNextStep.cancelling}
                    cancelEscalatesAt={conversationNextStep.cancelEscalatesAt}
                    compacting={conversationNextStep.compacting}
                    lastActivityRef={ctx.lastActivityRef}
                    onForceEndTurn={ctx.forceEndTurn}
                  />
                </div>
              )}
              {conversationNextStep?.kind === "scheduled_wakeup" && (
                <div className="mt-3">
                  <ScheduledWakeupBanner wakeAt={conversationNextStep.wakeAt} reason={conversationNextStep.reason} />
                </div>
              )}
              {conversationNextStep?.kind === "monitoring" && (
                <div className="mt-3">
                  <MonitoringBanner description={conversationNextStep.description} />
                </div>
              )}

              {state.pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.nonce}
                  approval={approval}
                  onResolve={(decision, optionId) => ctx.resolveApproval(approval.nonce, decision, optionId)}
                />
              ))}

              {state.pendingElicitations.map((elicitation) => (
                <AskUserQuestionCard
                  key={elicitation.nonce}
                  elicitation={elicitation}
                  onResolve={(resolution) => ctx.resolveElicitation(elicitation.nonce, resolution)}
                />
              ))}
            </div>
          </ThreadPrimitive.Viewport>
          {(!atBottom || ctx.canLoadNewerHistory) && (
            <button
              type="button"
              onPointerDown={requestLatest}
              onClick={(event) => {
                if (event.detail === 0) requestLatest();
              }}
              data-testid="acp-jump-to-latest"
              aria-label="Scroll to latest messages"
              title="Scroll to latest messages"
              // Centered: the composer collapse handle owns the bottom-right corner.
              className="absolute bottom-3 left-1/2 z-10 inline-flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-surface-700 bg-surface-800/95 text-text-secondary shadow-lg backdrop-blur transition-colors hover:text-text-primary active:scale-95"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
          )}
        </div>

        {/* Always mounted: the scroll observers need it even for a read-only trashed session. */}
        <div ref={belowViewportRef}>
          {composerAvailability.kind !== "read_only" && (
            <ComposerDock
              view={view}
              ctx={ctx}
              primerPrefill={primerPrefill}
              setPrimerPrefill={setPrimerPrefill}
              collapsible={composerCollapsible}
              collapsed={composerCollapsed}
              onToggleCollapsed={() => setComposerCollapsed((v) => !v)}
              availability={composerAvailability}
              conversationSync={conversationSync}
            />
          )}
        </div>
      </ThreadPrimitive.Root>
    </StructuredViewRoot>
  );
}

/** Queue and failure strips plus the composer. Only the composer collapses:
 *  the strips carry actionable state. */
function ComposerDock({
  view,
  ctx,
  primerPrefill,
  setPrimerPrefill,
  collapsible,
  collapsed,
  onToggleCollapsed,
  availability,
  conversationSync,
}: {
  view: Props;
  ctx: AcpContext;
  primerPrefill: Prefill;
  setPrimerPrefill: (prefill: Prefill) => void;
  collapsible: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  availability: Exclude<ComposerAvailability, { kind: "read_only" }>;
  conversationSync: ReturnType<typeof deriveConversationSyncStatus>;
}) {
  const { sessionId, acpWorkerState, acpAgent } = view;
  const { state, status } = ctx;
  const promptOutbox = derivePromptOutbox({
    queued: state.queuedPrompts,
    rejected: state.rejectedPrompts,
    waitingForRecovery: status !== "open" || (activeAgent?.kind !== "online" && activeAgent?.kind !== "dormant"),
  });
  return (
    <>
      <ComposerActionRail>
        <ComposerAvailabilityNotice availability={availability} conversationSync={conversationSync} />
        <PromptOutboxPanel
          outbox={promptOutbox}
          onRetry={ctx.sendPrompt}
          onDismissRejected={ctx.dismissRejectedPrompt}
          retryDisabled={availability.kind === "blocked" || availability.kind === "queue_for_recovery"}
          onRemoveQueued={ctx.removeQueuedPrompt}
          onEditQueued={ctx.editQueuedPrompt}
          onClearQueued={ctx.clearQueue}
          onSendQueuedNow={ctx.sendQueuedNow}
          canSendQueuedNow={canSendQueuedNow}
          sendQueuedNowInterrupts={sendNowInterruptsTurn}
        />
        <ModeSwitchFailedNotice failure={state.modeSwitchFailed} onDismiss={ctx.dismissModeSwitchFailed} />
        <ConfigOptionSwitchFailedNotice
          failure={state.configOptionSwitchFailed}
          configOptions={state.configOptions}
          onDismiss={ctx.dismissConfigOptionSwitchFailed}
        />
        <ContextPrimerBanner
          sessionId={sessionId}
          available={state.contextPrimerAvailable}
          onInsertPrimer={(text) =>
            setPrimerPrefill({
              id: `primer-${state.contextPrimerAvailable?.resetSeq ?? 0}-${Date.now()}`,
              text,
            })
          }
          onDismiss={ctx.dismissPrimer}
        />
        <CompactionReminderBanner
          state={state}
          onCompact={() => ctx.sendPrompt("/compact")}
          onDismiss={ctx.dismissCompactionReminder}
        />
      </ComposerActionRail>

      {collapsible && (
        <ChromeCollapseHandle
          edge="bottom"
          collapsed={collapsed}
          onToggle={onToggleCollapsed}
          collapseLabel="Collapse message composer"
          expandLabel="Expand message composer"
          controlsId="conversation-composer"
          testId="composer-collapse-toggle"
        />
      )}

      <CollapsibleRegion id="conversation-composer" collapsed={collapsible && collapsed}>
        <Composer
          key={sessionId}
          sessionId={sessionId}
          currentAgent={state.agent ?? acpAgent}
          yoloMode={view.yoloMode}
          availableModes={state.availableModes}
          currentModeId={state.currentModeId}
          legacyMode={state.mode}
          configOptions={state.configOptions}
          pendingConfigOption={state.pendingConfigOption}
          setConfigOption={ctx.setConfigOption}
          sessionUsage={state.sessionUsage}
          availableCommands={state.availableCommands}
          availability={availability}
          turnActive={state.turnActive}
          enqueuePrompt={ctx.sendPrompt}
          promptCapabilities={state.promptCapabilities}
          pendingAttachments={ctx.pendingAttachments}
          setPendingAttachments={ctx.setPendingAttachments}
          primerPrefill={primerPrefill}
          queuedPrompts={promptOutbox.legacy.queued}
          editQueuedPrompt={ctx.editQueuedPrompt}
        />
      </CollapsibleRegion>
    </>
  );
}

function ConversationAvailabilityNotice({ label }: { label: string }) {
  return (
    <div
      className="flex items-center gap-1.5 border-b border-surface-800/70 px-3 py-1.5 text-[11px] text-text-secondary"
      role="status"
    >
      <RotateCcw className="size-3 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
      {label}
    </div>
  );
}

export function composerAvailabilityNoticeLabel(
  availability: ComposerAvailability,
  conversationSync: ReturnType<typeof deriveConversationSyncStatus>,
): string | null {
  if (conversationSync === "reconnect") {
    return "Updating conversation…";
  }
  if (availability.kind === "queue_for_recovery") {
    return "Messages will be queued until the session resumes.";
  }
  return null;
}

function ComposerAvailabilityNotice({
  availability,
  conversationSync,
}: {
  availability: ComposerAvailability;
  conversationSync: ReturnType<typeof deriveConversationSyncStatus>;
}) {
  const label = composerAvailabilityNoticeLabel(availability, conversationSync);
  return label ? <ConversationAvailabilityNotice label={label} /> : null;
}

function EmptyState({ onPick }: { onPick: (text: string) => Promise<void> }) {
  return (
    <div className="mt-12 flex flex-col items-center gap-4 text-center">
      <div className="text-sm text-text-muted">Ask the agent anything about this workspace.</div>
      <div className="flex flex-wrap justify-center gap-2">
        {STARTER_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => void onPick(p)}
            className="rounded-full border border-surface-700 bg-surface-800/60 px-3 py-1 text-xs text-text-secondary hover:border-brand-600/60 hover:bg-surface-800 hover:text-text-primary"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function ClearedTurnsBanner({
  hiddenCount,
  expanded,
  onToggle,
}: {
  hiddenCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mb-4 w-full flex items-center gap-2 px-3 py-2 rounded-md border border-surface-700 bg-surface-800 text-text-secondary hover:bg-surface-700 hover:text-text-primary cursor-pointer text-sm"
      aria-expanded={expanded}
    >
      <ChevronDown
        size={14}
        className={`shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
        aria-hidden="true"
      />
      <span className="flex-1 text-left">
        {expanded ? "Hide" : "Show"} {hiddenCount} earlier turn
        {hiddenCount === 1 ? "" : "s"}
        <span className="text-text-dim"> (cleared, not in the model's memory)</span>
      </span>
    </button>
  );
}
