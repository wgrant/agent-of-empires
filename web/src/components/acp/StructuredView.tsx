/* eslint-disable react-refresh/only-export-components */
// Structured view conversation surface. assistant-ui renders the thread shell;
// state lives in AcpRuntime and is only fed to assistant-ui, never owned by it.

import { useLayoutEffect, useRef, useState } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { AlertTriangle, ChevronDown, RotateCcw } from "lucide-react";

import { useIsWideViewport } from "../../hooks/useIsWideViewport";
import { useConnectionIncidentVisibility } from "../../hooks/useConnectionIncidentVisibility";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { useRespawnSession } from "../../hooks/useRespawnSession";
import { useWebSettings } from "../../hooks/useWebSettings";
import { useDashboardConnectionDiagnostics } from "../../lib/connectionState";
import { lastClearIndex } from "../../lib/acpHistoryWindow";
import { derivePromptOutbox } from "../../lib/acpPromptOutbox";
import { AgentProfileProvider } from "../../lib/agentProfileContext";
import { conversationFontSizeRem } from "../../lib/conversationFontSize";
import type { FileRef, FileRefSession } from "../../lib/fileRef";
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
import { ModeSwitchFailedNotice, QueuedPromptsStrip, RejectedPromptsStrip } from "./PromptStrips";
import { MonitoringBanner, ScheduledWakeupBanner, SessionBanners } from "./SessionBanners";
import { ConfigOptionSwitchFailedNotice } from "./SessionConfigControls";
import { StartupErrorScreen } from "./StartupErrorScreen";
import { deriveStructuredConnectionDiagnostics, RateLimitRecoverySection, SystemNotices } from "./SystemNotices";
import { ComposerActionRail } from "./status/ComposerActionRail";
import {
  connectionComposerNotice,
  connectionStatusPresentation,
  selectConnectionDiagnostics,
  type ConnectionDiagnostics,
  type ConnectionStatusSnapshot,
  type SessionConnectionDiagnostics,
  type StreamTransportDiagnostics,
} from "./status/connectionStatus";
import { deriveConversationSyncStatus } from "./status/conversationSyncStatus";
import { deriveConversationStatus } from "./status/conversationStatus";
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
            acpWorkerState={acpWorkerState}
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
  // A rate limit with no reported reset still needs a key to scope resume status by.
  const rateLimitResume = useRespawnSession(
    sessionId,
    state.rateLimit ? (state.rateLimit.resets_at ?? "unknown") : null,
  );
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
    startupError: state.startupError !== null,
    workerStopped: state.workerStopped,
    workerRestarting: state.workerRestarting || acpWorkerState === "resuming",
    agentUnresponsive: state.agentUnresponsive,
    agentOrphaned: state.agentOrphaned,
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
    diagnostics: connectionDiagnostics,
    transport: streamTransport,
  };
  const dashboardConnection = useDashboardConnectionDiagnostics();
  const connectionSnapshot: ConnectionStatusSnapshot = { dashboard: dashboardConnection, session: sessionConnection };
  const displayConnectionDiagnostics = selectConnectionDiagnostics(connectionSnapshot);
  const conversationSync = deriveConversationSyncStatus({
    replaySyncing: ctx.replaySyncing,
    hasEverOpened: ctx.hasEverOpened,
    loadingEarlier: ctx.loadingEarlierHistory,
    connectionStarting: status === "connecting",
  });
  const conversationStatus = deriveConversationStatus({
    agentSession: connectionDiagnostics.session,
    sync: conversationSync,
    turnActive: state.turnActive,
    nextWakeupAt: state.nextWakeupAt,
    monitorArmed: state.monitorArmed,
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
      loadingEarlierHistory: ctx.loadingEarlierHistory,
      composerCollapsed,
      promptSeq: state.promptSeq,
      hasEverOpened: ctx.hasEverOpened,
      localInflight: state.inflightPromptIds.length > 0,
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
    <RateLimitRecoverySection
      sessionId={sessionId}
      currentAgent={state.agent ?? acpAgent}
      onPrefill={(text) => setPrimerPrefill({ id: `rate-limit-recovery-${Date.now()}`, text })}
    >
      {({ onSwitchAgent }) => (
        <SystemNotices
          sessionId={sessionId}
          status={status}
          serverReachability={ctx.serverReachability}
          lagged={state.lagged}
          rateLimit={state.rateLimit}
          rateLimitAutoResume={view.rateLimitAutoResume}
          rateLimitRetriesExhausted={state.rateLimitRetriesExhausted}
          startupError={state.startupError !== null}
          workerStopped={state.workerStopped}
          workerRestarting={state.workerRestarting || acpWorkerState === "resuming"}
          agentUnresponsive={state.agentUnresponsive}
          agentOrphaned={state.agentOrphaned}
          lastWebSocketOpenAt={ctx.lastWebSocketOpenAt}
          lastServerMessageAt={ctx.lastServerMessageAt}
          lastTransportDiagnostic={ctx.lastTransportDiagnostic}
          reconnectingSince={ctx.reconnectingSince}
          liveUpdatesStale={ctx.liveUpdatesStale}
          conversationSync={conversationSync}
          conversationStatus={conversationStatus}
          hasEverOpened={ctx.hasEverOpened}
          reconnecting={ctx.reconnecting}
          retryCount={ctx.retryCount}
          retryCountdown={ctx.retryCountdown}
          maxRetries={ctx.maxRetries}
          manualReconnect={ctx.manualReconnect}
          diagnostics={connectionDiagnostics}
          sessionConnection={sessionConnection}
          connectionSnapshot={connectionSnapshot}
          showConnectionIncident={connectionIncidentVisible}
          onSwitchAgent={onSwitchAgent}
          onResumeRateLimit={() => void rateLimitResume.respawn()}
          rateLimitResumeState={rateLimitResume.state}
          rateLimitResumeError={rateLimitResume.error}
        />
      )}
    </RateLimitRecoverySection>
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
        onRestore={view.onRestore}
        dismissError={ctx.dismissError}
      />

      <ThreadPrimitive.Root className="relative flex flex-1 flex-col min-h-0">
        {connectionNotice}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport
            autoScroll={false}
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

              {conversationStatus.kind === "active" && conversationStatus.cause === "working" && (
                <>
                  {/* A turn parked on an approval or question is waiting on the user, not stalled. */}
                  {state.pendingElicitations.length === 0 && state.pendingApprovals.length === 0 ? (
                    <div className="mt-3 ml-1">
                      <WorkingSpinner
                        thinking={state.thinking}
                        tool={state.inFlightTool?.name ?? null}
                        cancelling={state.cancelling}
                        cancelEscalatesAt={state.cancelEscalatesAt}
                        compacting={state.compacting}
                        lastActivityRef={ctx.lastActivityRef}
                        onForceEndTurn={ctx.forceEndTurn}
                      />
                    </div>
                  ) : null}
                </>
              )}

              {conversationStatus.kind === "waiting" &&
                conversationStatus.cause === "scheduled_wakeup" &&
                state.nextWakeupAt && (
                  <div className="mt-3">
                    <ScheduledWakeupBanner wakeAt={state.nextWakeupAt} reason={state.nextWakeupReason} />
                  </div>
                )}
              {conversationStatus.kind === "waiting" && conversationStatus.cause === "monitoring" && (
                <div className="mt-3">
                  <MonitoringBanner description={state.monitorDescription} />
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
              onClick={requestLatest}
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
          {!view.trashedAt && (
            <ComposerDock
              view={view}
              ctx={ctx}
              primerPrefill={primerPrefill}
              setPrimerPrefill={setPrimerPrefill}
              collapsible={composerCollapsible}
              collapsed={composerCollapsed}
              onToggleCollapsed={() => setComposerCollapsed((v) => !v)}
              connectionDiagnostics={connectionDiagnostics}
              conversationStatus={conversationStatus}
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
  connectionDiagnostics,
  conversationStatus,
}: {
  view: Props;
  ctx: AcpContext;
  primerPrefill: Prefill;
  setPrimerPrefill: (prefill: Prefill) => void;
  collapsible: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  connectionDiagnostics: ConnectionDiagnostics;
  conversationStatus: ReturnType<typeof deriveConversationStatus>;
}) {
  const { sessionId, acpWorkerState, acpAgent } = view;
  const { state, status } = ctx;
  const composerConnected = status === "open" && !state.workerStopped && !state.workerRestarting;
  const promptOutbox = derivePromptOutbox({
    queued: state.queuedPrompts,
    rejected: state.rejectedPrompts,
    waitingForRecovery:
      status !== "open" || acpWorkerState !== "running" || state.workerStopped || state.workerRestarting,
  });
  return (
    <>
      <ComposerActionRail>
        {conversationStatus.kind === "updating" && conversationStatus.cause === "reconnect" && (
          <ConversationRefreshNotice />
        )}
        {!composerConnected && <ComposerConnectionNotice diagnostics={connectionDiagnostics} />}
        <RejectedPromptsStrip
          rejected={promptOutbox.rejected}
          onRetry={ctx.sendPrompt}
          onDismiss={ctx.dismissRejectedPrompt}
          disabled={state.workerRestarting || state.workerStopped || Boolean(state.startupError)}
        />
        <ModeSwitchFailedNotice failure={state.modeSwitchFailed} onDismiss={ctx.dismissModeSwitchFailed} />
        <ConfigOptionSwitchFailedNotice
          failure={state.configOptionSwitchFailed}
          configOptions={state.configOptions}
          onDismiss={ctx.dismissConfigOptionSwitchFailed}
        />
        <QueuedPromptsStrip
          queued={promptOutbox.queued}
          onRemove={ctx.removeQueuedPrompt}
          onEdit={ctx.editQueuedPrompt}
          onClear={ctx.clearQueue}
          onSendNow={ctx.sendQueuedNow}
          canSendNow={ctx.canSendQueuedNow}
          sendNowInterrupts={ctx.sendNowInterruptsTurn}
          pendingResume={promptOutbox.queuedDelivery === "waiting_for_recovery"}
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
          connected={composerConnected}
          turnActive={state.turnActive}
          enqueuePrompt={ctx.sendPrompt}
          promptCapabilities={state.promptCapabilities}
          pendingAttachments={ctx.pendingAttachments}
          setPendingAttachments={ctx.setPendingAttachments}
          primerPrefill={primerPrefill}
          queuedPrompts={promptOutbox.queued}
          editQueuedPrompt={ctx.editQueuedPrompt}
        />
      </CollapsibleRegion>
    </>
  );
}

function ComposerConnectionNotice({ diagnostics }: { diagnostics: ConnectionDiagnostics }) {
  const presentation = connectionStatusPresentation(diagnostics.primary);
  const icon = presentation.working ? (
    <RotateCcw className="size-3 shrink-0 animate-spin" aria-hidden="true" />
  ) : (
    <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
  );
  const tone = presentation.tone === "error" ? "text-status-error" : "text-status-warning";
  return (
    <div
      className={`flex items-center gap-1.5 border-b border-surface-800/70 px-3 py-1.5 text-[11px] md:hidden ${tone}`}
      data-testid="composer-connection-notice"
      role="status"
    >
      {icon}
      <span>{connectionComposerNotice(diagnostics.primary)}</span>
    </div>
  );
}

function ConversationRefreshNotice() {
  return (
    <div
      className="flex items-center gap-1.5 border-b border-surface-800/70 px-3 py-1.5 text-[11px] text-text-secondary"
      role="status"
    >
      <RotateCcw className="size-3 shrink-0 animate-spin text-text-muted" aria-hidden="true" />
      Updating conversation…
    </div>
  );
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
