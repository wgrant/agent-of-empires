/* eslint-disable react-refresh/only-export-components */
// Structured view conversation surface. assistant-ui renders the thread shell;
// state lives in AcpRuntime and is only fed to assistant-ui, never owned by it.

import { useLayoutEffect, useRef, useState } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";
import { AlertTriangle, ChevronDown, RotateCcw } from "lucide-react";

import { useIsWideViewport } from "../../hooks/useIsWideViewport";
import { useMobileKeyboard } from "../../hooks/useMobileKeyboard";
import { useRespawnSession } from "../../hooks/useRespawnSession";
import { useWebSettings } from "../../hooks/useWebSettings";
import { lastClearIndex } from "../../lib/acpHistoryWindow";
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
import {
  deriveStructuredConnectionDiagnostics,
  RateLimitRecoverySection,
  SystemNotices,
} from "./SystemNotices";
import { ComposerActionRail } from "./status/ComposerActionRail";
import {
  connectionComposerNotice,
  connectionStatusPresentation,
  type ConnectionDiagnostics,
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
                value={{ agents: ctx.state.backgroundAgents, openPane: props.onOpenAgentsPane }}
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
  const connectionInset = connectionDiagnostics.hasIncident ? 44 : 0;
  const previousConnectionInsetRef = useRef(0);
  // Phone-width only: fold the composer away for reading.
  const composerCollapsible = !useIsWideViewport();
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const {
    viewportRef,
    belowViewportRef,
    messagesContentRef,
    atBottom,
    isCoarse,
    scrollToBottom,
    requestEarlierHistory,
  } = useTranscriptScroll({
    sessionId,
    canLoadEarlierHistory: ctx.canLoadEarlierHistory,
    loadEarlierHistory: ctx.loadEarlierHistory,
    loadingEarlierHistory: ctx.loadingEarlierHistory,
    composerCollapsed,
    promptSeq: state.promptSeq,
    hasEverOpened: ctx.hasEverOpened,
    localInflight: state.inflightPromptIds.length > 0,
  });
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
        conversationStatus={conversationStatus}
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
          {isCoarse && !atBottom && (
            <button
              type="button"
              onClick={scrollToBottom}
              data-testid="acp-jump-to-bottom"
              aria-label="Jump to latest"
              title="Jump to latest"
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
  return (
    <>
      <ComposerActionRail>
        {conversationStatus.kind === "updating" && conversationStatus.cause === "reconnect" && (
          <ConversationRefreshNotice />
        )}
        {!composerConnected && <ComposerConnectionNotice diagnostics={connectionDiagnostics} />}
        <RejectedPromptsStrip
          rejected={state.rejectedPrompts}
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
          queued={state.queuedPrompts}
          onRemove={ctx.removeQueuedPrompt}
          onEdit={ctx.editQueuedPrompt}
          onClear={ctx.clearQueue}
          onSendNow={ctx.sendQueuedNow}
          canSendNow={ctx.canSendQueuedNow}
          sendNowInterrupts={ctx.sendNowInterruptsTurn}
          pendingResume={
            status !== "open" || acpWorkerState !== "running" || state.workerStopped || state.workerRestarting
          }
        />
        <ContextPrimerBanner
          sessionId={sessionId}
          available={state.contextPrimerAvailable}
          onInsertPrimer={(text) =>
            setPrimerPrefill({ id: `primer-${state.contextPrimerAvailable?.resetSeq ?? 0}-${Date.now()}`, text })
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
          queuedPrompts={state.queuedPrompts}
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
<<<<<<< HEAD
=======

/** Render a "Xm Ys" / "Ys" elapsed-time string for the
 *  WorkingSpinner's "waiting on model" badge. Seconds-only under one
 *  minute, minutes + seconds otherwise. Single-digit seconds zero-pad
 *  in the minute case so "1m 09s" doesn't visually jump to "1m 10s"
 *  width-wise during the live tick. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem.toString().padStart(2, "0")}s`;
}

/* ── Working spinner (rattle) ────────────────────────────────────── */

export function WorkingSpinner({
  thinking,
  tool,
  cancelling,
  cancelEscalatesAt,
  compacting,
  lastActivityRef,
  onForceEndTurn,
}: {
  thinking: boolean;
  tool: string | null;
  cancelling: boolean;
  cancelEscalatesAt: string | null;
  compacting: boolean;
  lastActivityRef: React.RefObject<number>;
  onForceEndTurn: () => Promise<void>;
}) {
  const [frame, setFrame] = useState(0);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0xffffffff));
  // 1s-tick clock for the force-end-turn watchdog. We compare against
  // `lastActivityRef.current` (a ref bumped on every incoming frame)
  // and surface the escape hatch when the gap exceeds the threshold.
  // Polling here, not on every event, so the rest of the tree isn't
  // perturbed by activity bookkeeping. See #1100.
  const [stalledSecs, setStalledSecs] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, SPINNER_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      setSeed((s) => (s + 0x9e3779b9) | 0);
    }, VERB_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    // The hook starts the ref at 0 to avoid a render-time `Date.now()`
    // (react-hooks/purity). If we land here while it's still the
    // sentinel (e.g. mounting against a cached `turnActive=true`
    // state without yet receiving a fresh frame), pin it to now so
    // the watchdog clock isn't instantly tripped.
    if (lastActivityRef.current === 0) {
      lastActivityRef.current = Date.now();
    }
    const t = window.setInterval(() => {
      const last = lastActivityRef.current;
      setStalledSecs(Math.floor((Date.now() - last) / 1000));
    }, 1000);
    return () => window.clearInterval(t);
  }, [lastActivityRef]);

  // Live countdown to the cancel-escalation deadline while cancelling, so
  // "Stopping…" shows when the worker will be force-restarted. State-reset to
  // null is synced at render time (outside the effect) so it doesn't trigger
  // set-state-in-effect; the countdown interval runs in the effect.
  const [escalatesInSecs, setEscalatesInSecs] = useState<number | null>(null);
  if (!cancelEscalatesAt && escalatesInSecs !== null) {
    setEscalatesInSecs(null);
  }
  useEffect(() => {
    if (!cancelEscalatesAt) return;
    const target = new Date(cancelEscalatesAt).getTime();
    if (Number.isNaN(target)) return;
    const tick = () => {
      setEscalatesInSecs(Math.max(0, Math.ceil((target - Date.now()) / 1000)));
    };
    // Kick off the first value immediately (deferred a tick so it does not
    // count as set-state-in-effect) so the countdown shows on the same frame
    // the "Stopping..." badge appears rather than a second later.
    const kickoff = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(t);
    };
  }, [cancelEscalatesAt]);

  const state = deriveSpinnerState(thinking, tool);
  // Swap the rattle verb for an explicit "waiting on model" badge
  // with a live elapsed counter once the inactivity gap is clearly
  // longer than normal TTFT. The user can then distinguish "model
  // is taking a while" from "everything is wedged" without watching
  // logs. Threshold shared with the force-end-turn escape hatch. See
  // #1112.
  const showStalled = stalledSecs >= FORCE_END_TURN_THRESHOLD_SECS;
  const toolInFlight = tool != null;
  // A running /compact goes silent for 90 to 170 seconds, so it trips the
  // stall threshold every single time. Name the phase instead of burning
  // "Waiting on model" (the one label that means something is actually
  // wrong) on the one case where nothing is. Shown from the first tick,
  // not only past the threshold, so the counter reads as compaction
  // elapsed. See #3219.
  const label = cancelling
    ? escalatesInSecs != null && escalatesInSecs > 0
      ? `Stopping… (force in ${escalatesInSecs}s)`
      : "Stopping…"
    : compacting
      ? `Compaction in progress… ${formatElapsed(stalledSecs)}`
      : showStalled
        ? toolInFlight
          ? `Waiting on tool… ${formatElapsed(stalledSecs)}`
          : `Waiting on model… ${formatElapsed(stalledSecs)}`
        : chooseVerb(state, seed, tool);
  // A cancel is in flight: show the escape hatch even with a tool in
  // flight (the runaway loop IS a tool in flight). The legacy
  // force-end-turn button stays scoped to !toolInFlight so #1176's
  // anti-flicker rule for normal Task-subagent gaps is untouched.
  const showForceStop = cancelling;
  // Never offer the hatch during a compaction: it publishes a synthetic
  // Stopped plus a session/cancel, which is exactly the abort #2898 fixed
  // on the daemon side. The deliberate Stop path is still available.
  const showForceEnd = !cancelling && !compacting && showStalled && !toolInFlight;

  return (
    <div data-testid="acp-working-spinner" className="flex flex-col gap-2 text-sm italic text-text-muted">
      <div className="flex items-center gap-2">
        <span className="inline-block w-3 text-center font-mono text-brand-500" aria-hidden="true">
          {SPINNER_FRAMES[frame]}
        </span>
        <span>{label}</span>
      </div>
      {showForceStop ? (
        <button
          type="button"
          onClick={() => {
            void onForceEndTurn();
          }}
          className="self-start h-8 text-xs not-italic px-2 py-1 rounded-md border border-surface-700 bg-surface-800 text-text-secondary hover:bg-surface-700 hover:text-text-primary transition-colors cursor-pointer"
          title="The agent is ignoring the stop request. Force stop restarts the agent now (it resumes from the saved transcript; partial in-flight tool output is lost)."
        >
          Force stop
        </button>
      ) : showForceEnd ? (
        <button
          type="button"
          onClick={() => {
            void onForceEndTurn();
          }}
          className="self-start h-8 text-xs not-italic px-2 py-1 rounded-md border border-surface-700 bg-surface-800 text-text-secondary hover:bg-surface-700 hover:text-text-primary transition-colors cursor-pointer"
          title={`No streaming activity for ${stalledSecs}s. Clears the spinner and sends a best-effort cancel to the agent.`}
        >
          Force end turn
        </button>
      ) : null}
    </div>
  );
}

/* ── Plan strip ──────────────────────────────────────────────────── */

interface PlanStripProps {
  plan: Plan | null;
}

function PlanStrip({ plan }: PlanStripProps) {
  const [expanded, setExpanded] = useState(false);
  // Hide entirely when there are no steps to show. The mode picker
  // now lives in the composer footer, so the strip only earns its
  // pixels when there's a plan with at least one step. An agent that
  // emits an empty `plan.steps` array otherwise leaves a clickable
  // banner reading "0/0" with nothing under the disclosure.
  if (!plan || plan.steps.length === 0) return null;

  // Pick the active step: prefer an explicit `InProgress` (Claude's
  // ExitPlanMode bridge sets this), otherwise fall back to the first
  // non-Done / non-Cancelled step (TodoWrite-produced plans typically
  // arrive with all entries Pending). Mirrors the server-side
  // `plan_summary_from_plan` logic so the strip and sidebar agree.
  const current =
    plan.steps.find((s) => s.status === "InProgress") ??
    plan.steps.find((s) => s.status !== "Done" && s.status !== "Cancelled");
  const completed = plan.steps.filter((s) => s.status === "Done").length;
  const totalSteps = plan.steps.length;
  const pct = Math.round((completed / totalSteps) * 100);
  const allDone = completed === totalSteps;

  return (
    <div className="border-b border-surface-800 bg-surface-900/95 backdrop-blur">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-800/40"
        onClick={() => setExpanded((v) => !v)}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0 text-text-dim" />
        <span className="truncate text-text-primary">{current?.title ?? (allDone ? "all steps complete" : "…")}</span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-text-dim">
            {completed}/{totalSteps}
          </span>
          <span className="hidden sm:block h-1 w-16 overflow-hidden rounded-full bg-surface-800">
            <span className="block h-full bg-brand-500 transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </span>
          <ChevronDown
            className={["h-3.5 w-3.5 text-text-dim transition-transform", expanded ? "rotate-180" : ""].join(" ")}
          />
        </span>
      </button>

      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t border-surface-800 px-4 py-2 text-sm">
          <ul className="space-y-1">
            {plan.steps.map((step) => (
              <li key={step.id} className="flex items-start gap-2 text-text-secondary">
                <StepGlyph status={step.status} />
                <span
                  className={
                    step.status === "Done"
                      ? "text-text-dim line-through"
                      : step.status === "InProgress"
                        ? "text-text-primary font-medium"
                        : "text-text-secondary"
                  }
                >
                  {step.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StepGlyph({ status }: { status: Plan["steps"][number]["status"] }) {
  switch (status) {
    case "Done":
      return <span className="text-status-running">✓</span>;
    case "InProgress":
      return <span className="text-brand-500">●</span>;
    case "Cancelled":
      return <span className="text-text-dim">⊘</span>;
    case "Pending":
    default:
      return <span className="text-text-dim">○</span>;
  }
}

/* ── Approvals ───────────────────────────────────────────────────── */

function PendingApproval({
  approval,
  onResolve,
}: {
  approval: Approval;
  onResolve: (nonce: string, decision: ApprovalDecision, optionId?: string) => Promise<void>;
}) {
  // ApprovalCard owns its own chrome (matches the tool-card style).
  return (
    <ApprovalCard
      approval={approval}
      onResolve={(decision, optionId) => onResolve(approval.nonce, decision, optionId)}
    />
  );
}

/* ── System notices ──────────────────────────────────────────────── */

/** Wires the rate-limit handoff banner to the recovery modal. Owns the
 *  open/close toggle so StructuredView (which is wide and pulls in many
 *  hooks) does not have to. Exported so the wiring can be unit-tested
 *  without mounting all of StructuredView. See #1282. */
export function RateLimitRecoverySection({
  sessionId,
  currentAgent,
  onPrefill,
  children,
}: {
  sessionId: string;
  currentAgent: string | null;
  onPrefill: (text: string) => void;
  children: (renderProps: { onSwitchAgent: () => void }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {children({ onSwitchAgent: () => setOpen(true) })}
      <SwitchAgentModal
        open={open}
        sessionId={sessionId}
        currentAgent={currentAgent}
        onClose={() => setOpen(false)}
        onPrefill={onPrefill}
        trigger="rate_limit"
      />
    </>
  );
}

/** The agent's own wording for a rate limit, fit for a banner. On the prompt
 *  path `status` is already a sentence, but the defensive connection-end path
 *  (`classify_rate_limit_from_message`) puts the whole error Display string in,
 *  transport prefixes and the raw `{"errorKind":"rate_limit"}` fingerprint
 *  included, and that path never has a reported reset. Strip both so an unknown
 *  reset can never render a JSON payload. See #3152. */
function rateLimitWording(status: string): string {
  const text = status
    .replace(/[\s:]*\{[\s\S]*\}\s*$/, "")
    .replace(/^(?:ACP connection failed:\s*)?(?:Internal error:?\s*)?/, "")
    .trim();
  return text || "the agent did not report a reset time.";
}

function deriveStructuredConnectionDiagnostics(input: Omit<ConnectionStatusInput, "rateLimitText">) {
  return deriveConnectionDiagnostics({
    ...input,
    rateLimitText: (limit) => {
      // No reported reset means the agent never told us when the window
      // clears, so show what it did say rather than a made-up clock time.
      const reset = limit.resets_at === null ? null : new Date(limit.resets_at);
      return reset && !Number.isNaN(reset.getTime())
        ? `Rate-limited (${limit.kind}); resets at ${reset.toLocaleTimeString()}.`
        : `Rate-limited (${limit.kind}); ${rateLimitWording(limit.status)}`;
    },
  });
}

export function SystemNotices({
  sessionId = "",
  status,
  serverReachability,
  lagged,
  rateLimit,
  rateLimitAutoResume,
  rateLimitRetriesExhausted,
  startupError,
  workerStopped,
  workerRestarting,
  agentUnresponsive,
  agentOrphaned,
  lastWebSocketOpenAt,
  lastServerMessageAt,
  lastTransportDiagnostic,
  reconnectingSince,
  liveUpdatesStale,
  conversationSync = "idle",
  conversationStatus,
  hasEverOpened,
  reconnecting,
  retryCount,
  retryCountdown,
  maxRetries,
  manualReconnect,
  diagnostics: suppliedDiagnostics,
  onSwitchAgent,
  onResumeRateLimit,
  rateLimitResumeState = "idle",
  rateLimitResumeError = null,
}: {
  sessionId?: string;
  status: AcpContext["status"];
  serverReachability: AcpContext["serverReachability"];
  lagged: boolean;
  rateLimit: AcpState["rateLimit"];
  /** Whether auto-resume is armed for the session's profile; omitted when
   *  the caller does not know, in which case nothing is claimed. */
  rateLimitAutoResume?: boolean;
  rateLimitRetriesExhausted: boolean;
  startupError: boolean;
  workerStopped: boolean;
  workerRestarting: boolean;
  agentUnresponsive: boolean;
  agentOrphaned: boolean;
  lastWebSocketOpenAt: AcpContext["lastWebSocketOpenAt"];
  lastServerMessageAt: AcpContext["lastServerMessageAt"];
  lastTransportDiagnostic: AcpContext["lastTransportDiagnostic"];
  reconnectingSince: AcpContext["reconnectingSince"];
  liveUpdatesStale: AcpContext["liveUpdatesStale"];
  conversationSync?: ReturnType<typeof deriveConversationSyncStatus>;
  conversationStatus?: ConversationStatus;
  hasEverOpened: boolean;
  reconnecting: boolean;
  retryCount: number;
  retryCountdown: number;
  maxRetries: number;
  manualReconnect: () => void;
  diagnostics?: ConnectionDiagnostics;
  onSwitchAgent?: () => void;
  onResumeRateLimit?: () => void;
  rateLimitResumeState?: RespawnState;
  rateLimitResumeError?: string | null;
}) {
  const diagnostics =
    suppliedDiagnostics ??
    deriveStructuredConnectionDiagnostics({
      status,
      serverReachability,
      lagged,
      rateLimit,
      hasEverOpened,
      reconnecting,
      retryCount,
      retryCountdown,
      maxRetries,
      startupError,
      workerStopped,
      workerRestarting,
      agentUnresponsive,
      agentOrphaned,
      lastWebSocketOpenAt,
      lastServerMessageAt,
      lastTransportDiagnostic,
      reconnectingSince,
      liveUpdatesStale,
    });
  const initialSessionLoad = conversationSync === "initial";
  if (initialSessionLoad) return <InitialConversationLoadNotice sessionId={sessionId} />;
  const rateLimitIncident =
    conversationStatus?.kind === "blocked" && conversationStatus.cause === "rate_limited"
      ? true
      : rateLimit !== null && diagnostics.session === "rate_limited";
  const resumePending = rateLimitResumeState === "retrying" || rateLimitResumeState === "ok";
  const actions =
    rateLimitIncident && rateLimit && (onResumeRateLimit || onSwitchAgent) ? (
      <>
        {onResumeRateLimit && (
          <button
            type="button"
            onClick={onResumeRateLimit}
            disabled={resumePending}
            className="rounded-md border border-brand-700 bg-brand-900/40 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-brand-100 hover:bg-brand-900/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {rateLimitResumeState === "retrying"
              ? "Resuming…"
              : rateLimitResumeState === "ok"
                ? "Resume requested"
                : "Resume now"}
          </button>
        )}
        {onSwitchAgent && (
          <button
            type="button"
            onClick={onSwitchAgent}
            className="rounded-md border border-brand-700 bg-brand-900/40 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-brand-100 hover:bg-brand-900/60"
          >
            Continue in another agent
          </button>
        )}
        {rateLimitAutoResume === true && !rateLimitRetriesExhausted && (
          <span className="basis-full text-xs text-text-muted">
            Auto-resume is armed; the session resumes when the window clears.
          </span>
        )}
        {rateLimitAutoResume === false && (
          <span className="basis-full text-xs text-text-muted">
            Auto-resume is off for this profile; use Resume now, or enable acp.rate_limit_auto_resume.
          </span>
        )}
        {rateLimitRetriesExhausted && (
          <span className="basis-full text-xs text-status-warning">
            Auto-resume stopped after repeated attempts. Resume manually or send a new prompt.
          </span>
        )}
        {rateLimitResumeState === "ok" && (
          <span className="basis-full text-xs text-text-muted">
            Resume requested. New events should start streaming shortly.
          </span>
        )}
        {rateLimitResumeState === "failed" && rateLimitResumeError && (
          <span className="basis-full text-xs text-status-error">Resume failed: {rateLimitResumeError}</span>
        )}
      </>
    ) : undefined;
  return (
    <>
      <PublishedConnectionDiagnostics sessionId={sessionId} diagnostics={diagnostics} onReconnect={manualReconnect} />
      {diagnostics.hasIncident && (
        <ConnectionIncidentBubble diagnostics={diagnostics} onReconnect={manualReconnect} actions={actions} />
      )}
    </>
  );
}

function PublishedConnectionDiagnostics({
  sessionId,
  diagnostics,
  onReconnect,
}: {
  sessionId: string;
  diagnostics: ConnectionDiagnostics;
  onReconnect: () => void;
}) {
  const { publish, clear } = useConnectionDiagnosticsPublisher();
  useEffect(() => {
    publish({ sessionId, kind: "structured", diagnostics, onReconnect });
    return () => clear(sessionId);
  }, [clear, diagnostics, onReconnect, publish, sessionId]);
  return null;
}

function InitialConversationLoadNotice({ sessionId }: { sessionId: string }) {
  const { clear } = useConnectionDiagnosticsPublisher();
  useEffect(() => {
    clear(sessionId);
  }, [clear, sessionId]);
  return <ConversationLoadingBubble />;
}

export function ConversationLifecycleNotice({
  status,
  sessionId,
  startupError,
  workerStopped,
  agentUnresponsive,
  agentOrphaned,
  trashedAt,
  archivedAt,
  snoozedUntil,
  onRestore,
}: {
  status: ConversationStatus;
  sessionId: string;
  startupError: string | null;
  workerStopped: boolean;
  agentUnresponsive: boolean;
  agentOrphaned: boolean;
  trashedAt: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
  onRestore?: () => Promise<boolean> | void;
}) {
  if (status.kind === "blocked" && status.cause === "agent_failed" && startupError) {
    return <StartupErrorBanner sessionId={sessionId} message={startupError} />;
  }
  if (status.kind === "updating" && status.cause === "agent_restarting") {
    return <WorkerRestartingBanner agentUnresponsive={agentUnresponsive} agentOrphaned={agentOrphaned} />;
  }
  if (status.kind !== "blocked" || status.cause !== "agent_stopped") return null;

  const variant = pickWorkerStoppedVariant({
    workerStopped,
    startupError,
    trashedAt,
    archivedAt,
    snoozedUntil,
  });
  if (variant === "trashed") return <TrashedWorkerStoppedBanner sessionId={sessionId} onRestore={onRestore} />;
  if (variant === "archived") return <ArchivedWorkerStoppedBanner sessionId={sessionId} />;
  if (variant === "snoozed" && snoozedUntil) {
    return <SnoozedWorkerStoppedBanner sessionId={sessionId} snoozedUntil={snoozedUntil} />;
  }
  if (variant === "generic") return <WorkerStoppedBanner sessionId={sessionId} />;
  return null;
}

function ConversationLoadingBubble() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3" role="status">
      <div className="flex items-center gap-2 rounded-full border border-surface-700 bg-surface-850/95 px-3 py-1.5 text-xs text-text-secondary shadow-lg backdrop-blur-sm">
        <RotateCcw className="size-3 animate-spin text-text-muted" aria-hidden="true" />
        Loading conversation…
      </div>
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

function InteractionErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-status-warning">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">Action did not complete</div>
        <div className="mt-0.5 text-xs text-status-warning/90 break-words">{message}</div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md border border-status-warning/40 bg-status-warning/20 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-status-warning hover:bg-status-warning/30"
      >
        Dismiss
      </button>
    </div>
  );
}

export function WorkerRestartingBanner({
  agentUnresponsive,
  agentOrphaned,
}: {
  agentUnresponsive: boolean;
  agentOrphaned: boolean;
}) {
  // Three reasons land here:
  //   - `aoe acp restart` (deletes registry, daemon's reaper
  //     publishes Stopped{reason:"restart_pending"}, reconciler spawns
  //     a fresh worker with the cached acp_session_id).
  //   - Cancel-escalation watchdog fired: claude-agent-acp ignored
  //     `session/cancel` for the grace window, the supervisor SIGTERMed
  //     the wedged runner and is respawning via `session/load`.
  //   - Silent-orphan watchdog fired: the adapter finished streaming
  //     the turn but never sent the JSON-RPC `PromptResponse`; the
  //     supervisor restarts the runner the same way. See #1240.
  // All paths end with `AcpSessionAssigned` clearing the banner.
  // See #1196 for the agent_unresponsive variant.
  const message = agentOrphaned
    ? "Agent finished but didn't notify the daemon. Restarting worker; your transcript will be preserved."
    : agentUnresponsive
      ? "Agent stopped responding to cancel. Restarting worker; your transcript will be preserved."
      : "Restarting structured view worker… the daemon will respawn the agent with your existing transcript shortly.";
  return (
    <div className="flex items-center gap-2 border-b border-sky-900/60 bg-sky-950/40 px-4 py-2 text-xs text-sky-200">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

/** Shown while `SessionResponse.acp_worker_state === "stopping"`: the
 *  daemon has signalled the worker but has not proven it gone. Prompts are
 *  held and resumes refused until it settles. See #3487. */
export function WorkerStoppingBanner() {
  return (
    <div className="flex items-center gap-2 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-xs text-status-warning">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-status-warning" aria-hidden />
      <span>Stopping structured view worker… waiting for the agent process to exit before anything can resume.</span>
    </div>
  );
}

/** How long the post-fire "Waking…" state lingers before self-dismissing.
 *  A genuine fire flips `turnActive` (which hides this banner) within a
 *  second or two, so this only ever clears a stale banner. */
const WAKING_GRACE_MS = 10_000;

/** Top-of-structured view chip shown while the agent's `ScheduleWakeup` is
 *  pending. Visible only when no turn is in flight (turns produce their
 *  own busy chrome) and no other recovery banner is up. 1Hz local tick
 *  for the countdown; once the wake fires the next UserPromptSent
 *  clears `state.nextWakeupAt` on the reducer side and this unmounts.
 *  See #1091.
 *
 *  A fallback `ScheduleWakeup` superseded by its primary signal (a turn
 *  that fired before `wakeAt`) leaves `nextWakeupAt` set with nothing
 *  left to clear it: a prompt arriving before `wakeAt` is kept on
 *  purpose, and once `wakeAt` passes no further prompt lands. That left
 *  "Waking…" stuck indefinitely. Self-dismiss `WAKING_GRACE_MS` after
 *  firing so the stale banner clears on its own. */
export function ScheduledWakeupBanner({ wakeAt, reason }: { wakeAt: string; reason: string | null }) {
  const targetMs = Date.parse(wakeAt);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(false);
  const elapsed = !Number.isFinite(targetMs) || targetMs <= now;
  // A fresh wake reuses this instance (same render slot); un-dismiss
  // during render so the new countdown shows.
  const [prevWakeAt, setPrevWakeAt] = useState(wakeAt);
  if (wakeAt !== prevWakeAt) {
    setPrevWakeAt(wakeAt);
    setDismissed(false);
  }
  useEffect(() => {
    if (elapsed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [elapsed]);
  useEffect(() => {
    if (!elapsed) return;
    const id = setTimeout(() => setDismissed(true), WAKING_GRACE_MS);
    return () => clearTimeout(id);
  }, [elapsed]);
  if (!Number.isFinite(targetMs) || dismissed) return null;
  const remaining = Math.max(0, Math.floor((targetMs - now) / 1000));
  const wakeDate = new Date(targetMs);
  const clock = `${String(wakeDate.getHours()).padStart(2, "0")}:${String(wakeDate.getMinutes()).padStart(2, "0")}`;
  let label: string;
  if (elapsed) {
    label = "Waking…";
  } else if (remaining < 60) {
    label = `Asleep until ${clock} (in ${remaining}s)`;
  } else if (remaining < 3600) {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    label = `Asleep until ${clock} (in ${m}m ${String(s).padStart(2, "0")}s)`;
  } else {
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    label = `Asleep until ${clock} (in ${h}h ${m}m)`;
  }
  return (
    <div className="flex items-center gap-2 border-b border-sky-900/60 bg-sky-950/40 px-4 py-2 text-xs text-sky-200">
      <span aria-hidden className="text-base leading-none">
        ⏰
      </span>
      <span className="truncate">
        {label}
        {reason ? <span className="text-sky-300/70">: {reason}</span> : null}
      </span>
    </div>
  );
}

/** Top-of-structured view chip shown while the agent has an armed
 *  `Monitor` (a background watch). Unlike the wakeup banner there is no
 *  fire time, so this is a static "monitoring" notice with no countdown.
 *  Visible only when no turn is in flight (a firing monitor produces its
 *  own busy chrome) and no other recovery banner is up; clears on the next
 *  user prompt via `state.monitorArmed`. */
function MonitoringBanner({ description }: { description: string | null }) {
  return (
    <div className="flex items-center gap-2 border-b border-violet-900/60 bg-violet-950/40 px-4 py-2 text-xs text-violet-200">
      <span aria-hidden className="text-base leading-none">
        👁
      </span>
      <span className="truncate">
        Monitoring a background job
        {description ? <span className="text-violet-300/70">: {description}</span> : null}
      </span>
    </div>
  );
}

function WorkerStoppedBanner({ sessionId }: { sessionId: string }) {
  // The next AcpSessionAssigned (or UserPromptSent) clears workerStopped on
  // the reducer side and this banner unmounts.
  const { state: retryState, error: retryError, respawn: handleReconnect } = useRespawnSession(sessionId);

  return (
    <div className="border-b border-status-warning/30 bg-status-warning/10 px-4 py-3 text-status-warning">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Structured view worker stopped</div>
          <div className="mt-1 text-xs text-status-warning/90">
            The agent was terminated via <code className="rounded bg-status-warning/30 px-1">aoe acp stop</code> or an
            equivalent external teardown. New prompts are disabled until you reconnect.
          </div>
        </div>
        <button
          type="button"
          onClick={handleReconnect}
          disabled={retryState === "retrying"}
          className="shrink-0 rounded-md border border-status-warning/40 bg-status-warning/20 px-3 py-1 text-xs font-medium text-status-warning hover:bg-status-warning/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {retryState === "retrying" ? "Reconnecting…" : "Reconnect"}
        </button>
      </div>
      {retryState === "ok" && (
        <div className="mt-2 text-xs text-emerald-200/90">
          Spawn requested. The composer will re-enable when the agent is back online.
        </div>
      )}
      {retryState === "failed" && retryError && (
        <div className="mt-2 text-xs text-status-warning/90">Reconnect failed: {retryError}</div>
      )}
    </div>
  );
}

/** Replacement for `WorkerStoppedBanner` when the worker was torn
 *  down because the user archived the session from the sidebar. The
 *  reconnect button would be misleading here: the reconciler and the
 *  startup recovery path both skip archived sessions, so a fresh
 *  spawn would not survive the next reconciliation tick. The user
 *  unblocks by unarchiving from the sidebar context menu. See #1581. */
/** Replacement for `WorkerStoppedBanner` when the session is in the trash
 *  (#2489). The transcript is still readable (the event store keeps it until
 *  purge), but the worker is stopped and the reconciler will not respawn a
 *  trashed session, so the composer is disabled and the banner points at the
 *  sidebar Trash section to restore. */
export function TrashedWorkerStoppedBanner({
  sessionId,
  onRestore,
}: {
  sessionId: string;
  onRestore?: () => Promise<boolean> | void;
}) {
  // Local pending flag: on success the reducer re-buckets the session and this
  // banner unmounts, so the flag never has to clear on the happy path; on a
  // failed restore we reset it and let the aggregate error toast explain.
  const [restoring, setRestoring] = useState(false);

  const handleRestore = () => {
    if (!onRestore || restoring) return;
    setRestoring(true);
    void Promise.resolve(onRestore()).then(
      (ok) => {
        if (ok === false) setRestoring(false);
      },
      () => setRestoring(false),
    );
  };

  return (
    <div
      className="border-b border-status-warning/30 bg-status-warning/10 px-4 py-3 text-status-warning"
      data-testid={`acp-trashed-banner-${sessionId}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Session in trash</div>
          <div className="mt-1 text-xs text-status-warning/90">
            This session is in the trash. Its transcript and workspace are kept and shown here read-only, but the worker
            is stopped and will not respawn. Restore it to resume, or delete it permanently from the Trash section in
            the sidebar.
          </div>
        </div>
        {onRestore && (
          <button
            type="button"
            onClick={handleRestore}
            disabled={restoring}
            className="shrink-0 rounded-md border border-status-warning/40 bg-status-warning/20 px-3 py-1 text-xs font-medium text-status-warning hover:bg-status-warning/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
        )}
      </div>
    </div>
  );
}

export function ArchivedWorkerStoppedBanner({ sessionId }: { sessionId: string }) {
  return (
    <div
      className="border-b border-status-warning/30 bg-status-warning/10 px-4 py-3 text-status-warning"
      data-testid={`acp-archived-banner-${sessionId}`}
    >
      <div className="text-sm font-medium">Session archived</div>
      <div className="mt-1 text-xs text-status-warning/90">
        This session is parked. The structured view worker was shut down and the reconciler will not respawn it.
        Unarchive from the sidebar (right-click the row, then Unarchive) to bring it back.
      </div>
    </div>
  );
}

/** Replacement for `WorkerStoppedBanner` when the worker was torn
 *  down because the user snoozed the session. Surfaces the wake time
 *  so the user knows when the worker will come back on its own;
 *  Unsnooze from the sidebar context menu wakes it sooner. See
 *  #1581. */
export function SnoozedWorkerStoppedBanner({ sessionId, snoozedUntil }: { sessionId: string; snoozedUntil: string }) {
  const target = new Date(snoozedUntil);
  const wallClock = Number.isFinite(target.getTime()) ? target.toLocaleString() : snoozedUntil;
  return (
    <div
      className="border-b border-status-warning/30 bg-status-warning/10 px-4 py-3 text-status-warning"
      data-testid={`acp-snoozed-banner-${sessionId}`}
    >
      <div className="text-sm font-medium">Session snoozed</div>
      <div className="mt-1 text-xs text-status-warning/90">
        The structured view worker was shut down until <span className="font-mono">{wallClock}</span>. The reconciler
        will respawn it automatically once the snooze expires, or you can Unsnooze from the sidebar (right-click the
        row) to wake it sooner.
      </div>
    </div>
  );
}

export function StartupErrorBanner({ sessionId, message }: { sessionId: string; message: string }) {
  const isAuth = /authentic|login|api[_ -]?key/i.test(message);
  const isCapacity = /capacity full|max_concurrent_workers/i.test(message);
  // Match the exact `Display` of `AcpError::ProjectPathMissing`.
  // Capture the path so the banner can echo it back to the user; the
  // path lets them spot whether a rename or a delete is the cause and
  // jump straight to the right fix. See #1089.
  const projectPathMissingMatch = /project path no longer exists:\s*(\S.*)$/im.exec(message);
  const isProjectPathMissing = projectPathMissingMatch !== null;
  const missingPath = projectPathMissingMatch?.[1]?.trim() ?? null;
  // The adapter found the bundled Claude Code native sub-binary at the
  // global-npm path but `execve` failed. Usually arch/libc/loader
  // mismatch inside a sandbox container, or a bind-mounted host
  // node_modules whose binary doesn't match the container arch. See
  // #1449.
  const isNativeBinaryLaunchFail = /native binary at .* exists but failed to launch/i.test(message);
  // The supervisor's drain task starts emitting events shortly after a
  // successful respawn; the banner disappears when the next user prompt
  // clears `startupError`.
  const { state: retryState, error: retryError, respawn: handleRetry } = useRespawnSession(sessionId);

  return (
    <div className="border-b border-rose-900/60 bg-rose-950/40 px-4 py-3 text-rose-200">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Structured view agent failed to start</div>
          <pre className="mt-1 whitespace-pre-wrap text-xs text-rose-100/90">{message}</pre>
        </div>
        <button
          type="button"
          onClick={handleRetry}
          disabled={retryState === "retrying"}
          className="shrink-0 rounded-md border border-rose-800/60 bg-rose-900/40 px-3 py-1 text-xs font-medium text-rose-100 hover:bg-rose-900/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {retryState === "retrying" ? "Retrying…" : "Retry"}
        </button>
      </div>
      {retryState === "ok" && (
        <div className="mt-2 text-xs text-emerald-200/90">
          Spawn requested. New events should start streaming in shortly.
        </div>
      )}
      {retryState === "failed" && retryError && (
        <div className="mt-2 text-xs text-rose-100/90">Retry failed: {retryError}</div>
      )}
      <div className="mt-2 text-xs text-rose-200/80">
        {isAuth ? (
          <>
            The adapter is installed but has no Claude credentials. Either set{" "}
            <code className="rounded bg-rose-900/60 px-1">ANTHROPIC_API_KEY</code> in the env that runs{" "}
            <code className="rounded bg-rose-900/60 px-1">aoe serve</code>, or run{" "}
            <code className="rounded bg-rose-900/60 px-1">claude /login</code> in a terminal to write credentials to{" "}
            <code className="rounded bg-rose-900/60 px-1">~/.claude</code>, then restart aoe.
          </>
        ) : isCapacity ? (
          <>
            All structured view worker slots are in use. Either raise{" "}
            <code className="rounded bg-rose-900/60 px-1">[acp] max_concurrent_workers</code> in{" "}
            <code className="rounded bg-rose-900/60 px-1">config.toml</code> and restart{" "}
            <code className="rounded bg-rose-900/60 px-1">aoe serve</code>, or free a slot by deleting an existing
            structured view session or switching one to the tmux view. Reinstalling the adapter won't help; the adapter
            is fine, the cap is the limit.
          </>
        ) : isProjectPathMissing ? (
          <>
            The session's working directory no longer exists on disk:
            {missingPath && (
              <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-rose-900/40 p-2 text-xs">{missingPath}</pre>
            )}
            Reinstalling the adapter won't help; the adapter is fine, the cwd is gone. Two paths forward:
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                Restore the directory at the path above (e.g.{" "}
                <code className="rounded bg-rose-900/60 px-1">git worktree move</code> it back, or recreate it), then
                click <strong>Retry</strong>.
              </li>
              <li>
                Stop <code className="rounded bg-rose-900/60 px-1">aoe serve</code>, edit{" "}
                <code className="rounded bg-rose-900/60 px-1">project_path</code> for this session in{" "}
                <code className="rounded bg-rose-900/60 px-1">
                  ~/.agent-of-empires/profiles/&lt;profile&gt;/sessions.json
                </code>{" "}
                to point at the new location, then start <code className="rounded bg-rose-900/60 px-1">aoe serve</code>{" "}
                again.
              </li>
            </ol>
          </>
        ) : isNativeBinaryLaunchFail ? (
          <>
            The adapter is installed but its bundled Claude Code native sub-binary couldn't launch. The binary exists on
            disk, the kernel rejected the <code className="rounded bg-rose-900/60 px-1">execve</code>. Reinstalling the
            adapter won't help; the binary is already there. Likely causes:
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>
                Architecture mismatch (e.g. an <code className="rounded bg-rose-900/60 px-1">arm64</code> binary inside
                an <code className="rounded bg-rose-900/60 px-1">amd64</code> sandbox container, or vice versa).
              </li>
              <li>Container image missing the dynamic loader or a glibc version old enough to refuse the binary.</li>
              <li>
                Host <code className="rounded bg-rose-900/60 px-1">node_modules</code> bind-mounted into a container of
                a different arch.
              </li>
            </ul>
            Open the agent log below for the verbatim adapter error, or see{" "}
            <a
              href="https://agent-of-empires.com/docs/structured-view#native-binary-launch-failure"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-rose-100"
            >
              the troubleshooting guide
            </a>
            .
          </>
        ) : (
          <>
            Run <code className="rounded bg-rose-900/60 px-1">aoe acp doctor --fix</code> from a terminal, or install
            the adapter manually:
            <pre className="mt-1 whitespace-pre-wrap rounded bg-rose-900/40 p-2 text-xs">
              npm install -g @agentclientprotocol/claude-agent-acp@latest
            </pre>
          </>
        )}
      </div>
      <AgentLogDisclosure sessionId={sessionId} />
    </div>
  );
}

/** Collapsible viewer for the per-session structured view runner log.
 *
 *  Surfaces the same stream `aoe acp logs --session <id>` reads,
 *  so a dashboard user without host terminal access (Tailscale Funnel,
 *  remote setups) can see the verbatim adapter error when the startup
 *  banner is otherwise opaque. See #1449.
 */
function AgentLogDisclosure({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "failed">("idle");
  const [tail, setTail] = useState<string>("");
  const [exists, setExists] = useState<boolean>(false);
  const [truncated, setTruncated] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const fetchLog = async () => {
    setState("loading");
    setErrorText(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/worker-log?tail=200`);
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        setState("failed");
        setErrorText(`Server returned ${res.status}. ${detail}`.trim());
        return;
      }
      const body = (await res.json()) as {
        path?: string;
        exists?: boolean;
        tail?: string;
        truncated?: boolean;
      };
      setExists(Boolean(body.exists));
      setTail(typeof body.tail === "string" ? body.tail : "");
      setTruncated(Boolean(body.truncated));
      setState("ok");
    } catch (e) {
      setState("failed");
      setErrorText(e instanceof Error ? e.message : String(e));
    }
  };

  const handleToggle = () => {
    const next = !open;
    setOpen(next);
    if (next && state === "idle") {
      void fetchLog();
    }
  };

  return (
    <div className="mt-3 border-t border-rose-900/60 pt-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={handleToggle}
          data-testid="acp-agent-log-toggle"
          aria-expanded={open}
          className="text-xs font-medium text-rose-100 underline-offset-2 hover:underline"
        >
          {open ? "Hide agent log" : "Open agent log"}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => void fetchLog()}
            disabled={state === "loading"}
            data-testid="acp-agent-log-refresh"
            className="rounded-md border border-rose-800/60 bg-rose-900/40 px-2 py-0.5 text-[10px] font-medium text-rose-100 hover:bg-rose-900/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {state === "loading" ? "Loading…" : "Refresh"}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2" data-testid="acp-agent-log-body">
          {state === "loading" && <div className="text-xs text-rose-200/80">Loading log…</div>}
          {state === "failed" && errorText && (
            <div className="text-xs text-rose-100/90">Could not load log: {errorText}</div>
          )}
          {state === "ok" && !exists && (
            <div className="text-xs text-rose-200/80">
              No log output yet. The worker may not have written anything before exiting.
            </div>
          )}
          {state === "ok" && exists && tail.length === 0 && (
            <div className="text-xs text-rose-200/80">Log file exists but is empty.</div>
          )}
          {state === "ok" && exists && tail.length > 0 && (
            <>
              {truncated && <div className="mb-1 text-[10px] text-rose-200/70">Log is large; showing the tail.</div>}
              <pre
                data-testid="acp-agent-log-pre"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-rose-950/70 p-2 font-mono text-[11px] text-rose-100/90"
              >
                {tail}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Mode-switch-failed notice ────────────────────────────────────── */

interface ModeSwitchFailedNoticeProps {
  failure: { modeId: string; reason: string; at: string } | null;
  onDismiss: () => void;
}

/** Non-blocking notice rendered when the ACP adapter rejected a
 *  `session/set_mode` request. The most common path: a user enabled
 *  yolo_mode_default but the claude-agent-acp build does not expose
 *  `bypassPermissions` (gated on the `ALLOW_BYPASS` env var), so the
 *  session keeps running in `default` and silently prompts on every
 *  Write/Edit/Bash. The notice gives them an explicit signal plus a
 *  pointer to the mode picker. See #1233. */
function ModeSwitchFailedNotice({ failure, onDismiss }: ModeSwitchFailedNoticeProps) {
  if (!failure) return null;
  const friendly =
    failure.modeId === "bypassPermissions"
      ? "YOLO mode (bypassPermissions) is not available on this adapter; the session is running in default permission mode. claude-agent-acp gates bypass on the ALLOW_BYPASS env var. Pick a different mode from the composer or restart the daemon with ALLOW_BYPASS=1."
      : `Could not switch to mode "${failure.modeId}"; the session is staying on its previous mode. Pick a different mode from the composer.`;
  return (
    <ActionFeedbackNotice
      title={friendly}
      detail={failure.reason}
      onDismiss={onDismiss}
      dismissLabel="Dismiss mode-switch notice"
    />
  );
}

/* ── Queued prompts strip ─────────────────────────────────────────── */

interface QueuedPromptsStripProps {
  queued: QueuedPrompt[];
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onClear: () => void;
  /** Force-send a single queued prompt: send it now when the agent is free,
   *  or interrupt (cancel) a running non-steerable turn so the queue drains. */
  onSendNow: (prompt: QueuedPrompt) => void;
  /** Whether "Send now" can act at all (socket up, worker alive). Gates the
   *  per-row button. */
  canSendNow: boolean;
  /** Whether pressing "Send now" would interrupt a running turn rather than
   *  send immediately. Drives the button's warning tooltip. */
  sendNowInterrupts: boolean;
  /** True when the session is not in a state where the drain effect
   *  can fire (WS closed, worker stopped, worker restarting, or the
   *  worker is still cold-starting). Drives the heading copy so the
   *  user can tell whether queued prompts fire on the next turn-end
   *  or wait for the session to resume. See #1359. */
  pendingResume: boolean;
}

/** Strip rendered above the composer listing prompts the user has
 *  queued mid-turn. Each row is editable in place (click to edit, save
 *  on Enter or blur, cancel on Escape) and removable via the X button.
 *  Hidden when the queue is empty. See #1031. */
function RejectedPromptsStrip({
  rejected,
  onRetry,
  onDismiss,
  disabled,
}: {
  rejected: RejectedPrompt[];
  onRetry: (text: string) => void;
  /** Drop a single pill without resending. Local-only; the daemon has
   *  no record of pending rejections so this never goes over the wire. */
  onDismiss: (id: string) => void;
  /** True while the worker is restarting/stopped/in startup error.
   *  Retry must be gated then: `sendPrompt` would clear
   *  `workerRestarting` / `agentUnresponsive` and the rejected pills
   *  before the respawn has produced a new `AcpSessionAssigned`,
   *  leaving the UI claiming the agent is ready while the daemon
   *  hasn't reconnected yet. Dismiss stays available so the user can
   *  clear stale pills during the respawn. See #1196. */
  disabled: boolean;
}) {
  // Pills for prompts the daemon refused while another `session/prompt`
  // was already in flight. The user sees the rejection and can re-fire
  // via the Retry button instead of having their message vanish. The
  // reducer caps the list at 5 entries (oldest dropped) and clears on
  // the next UserPromptSent. See #1196.
  if (rejected.length === 0) return null;
  return (
    <div className="border-t border-amber-900/40 bg-amber-950/20 px-4 py-2">
      <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl">
        <div className="pb-1.5 text-[11px] uppercase tracking-wider text-amber-300">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Rejected ({rejected.length})
          </span>
        </div>
        <ul className="flex flex-col gap-1.5">
          {rejected.map((r) => (
            <li
              key={r.id}
              className="group flex items-start gap-2 rounded-lg border border-amber-700/30 bg-amber-950/15 px-2.5 py-1.5"
            >
              <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-semibold text-amber-300">
                !
              </span>
              <div className="min-w-0 flex-1">
                {/* Bound a huge rejected paste to a scrollable box so it
                    cannot grow the strip and shove the composer off-screen,
                    same hazard as the queued rows. See #1642. */}
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs text-amber-100">
                  {r.text}
                </p>
                <p className="mt-0.5 text-[10px] text-amber-400/80">Agent was busy; prompt was not sent.</p>
              </div>
              <button
                type="button"
                onClick={() => onRetry(r.text)}
                disabled={disabled}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-700/60 bg-amber-900/30 px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-amber-100 hover:bg-amber-900/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-amber-900/30"
                aria-label="Retry rejected prompt"
              >
                <RotateCcw className="h-3 w-3" />
                Retry
              </button>
              <button
                type="button"
                onClick={() => onDismiss(r.id)}
                className="inline-flex shrink-0 items-center justify-center rounded-md border border-amber-700/40 bg-amber-900/20 p-1 text-amber-200 hover:bg-amber-900/60"
                aria-label="Dismiss rejected prompt"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function QueuedPromptsStrip({
  queued,
  onRemove,
  onEdit,
  onClear,
  onSendNow,
  canSendNow,
  sendNowInterrupts,
  pendingResume,
}: QueuedPromptsStripProps) {
  // Strip-level collapse: when the queue exceeds `visibleDefault` rows,
  // only the first N render until the user expands. State resets when
  // the queue length drops back below the threshold (toggle disappears;
  // `expanded` stays harmlessly true and re-arms on the next overflow).
  // Mobile gets N=1 because a single multi-line prompt already eats
  // half the small-viewport composer area; desktop tolerates N=2.
  // See #1232.
  const isMobile = useIsCoarsePointer();
  const [expanded, setExpanded] = useState(false);
  const aliases = useClearAliases();
  if (queued.length === 0) return null;
  const layout = queuedStripLayout({
    queuedCount: queued.length,
    isMobile,
    expanded,
  });
  const visible = queued.slice(0, layout.visibleCount);
  return (
    <div className="border-t border-surface-800 bg-surface-900/60 px-4 py-2">
      <div className="mx-auto max-w-3xl xl:max-w-4xl 2xl:max-w-5xl">
        <div className="flex items-center justify-between pb-1.5 text-[11px] uppercase tracking-wider text-text-dim">
          {/* The queue is browser-local, which is not something a user can
              work out from the strip. Say so here rather than let them
              assume the daemon is holding the message. See #3331. */}
          <span
            className="inline-flex items-center gap-1"
            title="Queued in this browser. Sends when the agent is free, even from another chat, as long as a dashboard tab stays open. Three closed chats deliver in the background at a time; the rest wait for a slot or for you to open them. Your other devices do not see it."
          >
            <Clock className="h-3 w-3" />
            {pendingResume ? `Pending until session resumes (${queued.length})` : `Queued (${queued.length})`}
          </span>
          {queued.length > 1 && (
            <button
              type="button"
              onClick={onClear}
              className="text-text-dim hover:text-text-secondary transition-colors"
            >
              Clear all
            </button>
          )}
        </div>
        <ul className="flex flex-col gap-1.5">
          {visible.map((q, i) => {
            // Insert a clear-boundary divider between this row and the
            // previous when either side is a clear-command alias. Signals
            // that the drain effect will fire these as separate POSTs
            // rather than gluing them into one combined prompt (#1356).
            const prev = i > 0 ? visible[i - 1] : undefined;
            const showDivider =
              aliases.length > 0 &&
              prev !== undefined &&
              (isClearAlias(prev.text, aliases) || isClearAlias(q.text, aliases));
            return (
              <Fragment key={q.id}>
                {showDivider && (
                  <li
                    aria-hidden="true"
                    data-testid="queued-clear-boundary"
                    className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-amber-300/60"
                  >
                    <span className="h-px flex-1 bg-amber-500/20" />
                    fires separately
                    <span className="h-px flex-1 bg-amber-500/20" />
                  </li>
                )}
                <QueuedPromptRow
                  prompt={q}
                  onRemove={() => onRemove(q.id)}
                  onEdit={(text) => onEdit(q.id, text)}
                  onSendNow={() => onSendNow(q)}
                  canSendNow={canSendNow}
                  sendNowInterrupts={sendNowInterrupts}
                />
              </Fragment>
            );
          })}
        </ul>
        {layout.toggleLabel && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 w-full rounded-md border border-sky-700/20 bg-sky-950/10 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-sky-300 hover:bg-sky-950/30"
          >
            {layout.toggleLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function QueuedPromptRow({
  prompt,
  onRemove,
  onEdit,
  onSendNow,
  canSendNow,
  sendNowInterrupts,
}: {
  prompt: QueuedPrompt;
  onRemove: () => void;
  onEdit: (text: string) => void;
  onSendNow: () => void;
  canSendNow: boolean;
  sendNowInterrupts: boolean;
}) {
  // Editor state co-mounts with the textarea: when `editing` flips on
  // we re-key <QueuedPromptEditor> so it initialises `draft` from the
  // current prompt.text. This avoids a setState-in-effect to keep the
  // draft synced with external edits (lint: react-hooks/set-state-in-effect).
  const [editing, setEditing] = useState(false);
  // Per-row clamp: long / multi-line prompts only render their first
  // few lines in display mode. The `…` affordance lifts the clamp
  // without entering edit mode. The clamp is undone automatically when
  // the editor mounts, since the textarea has its own sizing logic.
  // See #1232.
  const [rowExpanded, setRowExpanded] = useState(false);
  const isLong = isQueuedPromptLong(prompt.text);

  return (
    <li className="group flex items-start gap-2 rounded-lg border border-sky-700/30 bg-sky-950/15 px-2.5 py-1.5">
      <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-semibold text-sky-300">
        ⏱
      </span>
      {editing ? (
        <QueuedPromptEditor
          key={prompt.id}
          initial={prompt.text}
          onCancel={() => setEditing(false)}
          onSave={(text) => {
            const trimmed = text.trim();
            if (trimmed && trimmed !== prompt.text) onEdit(trimmed);
            setEditing(false);
          }}
        />
      ) : (
        <div className="min-w-0 flex-1">
          {/* When expanded, a huge paste is bounded to a scrollable box
              (max-h matches the composer's max-h-[200px]) so it can never
              grow the strip and push the composer off-screen. The toggle
              below stays a sibling of this box, so capping the height also
              keeps "Show less" reachable. See #1642. */}
          <div className={isLong && rowExpanded ? "max-h-48 overflow-y-auto" : ""}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              title="Click to edit"
              className={[
                "w-full text-left text-xs leading-5 text-text-secondary whitespace-pre-wrap break-words hover:text-text-primary",
                // `line-clamp-3` only clamps when it owns the element's
                // display (`-webkit-box`). A static `block` here wins the
                // cascade and silently kills the clamp, so a huge collapsed
                // paste renders in full. Keep `block` and `line-clamp-3`
                // mutually exclusive. See #1642.
                isLong && !rowExpanded ? "line-clamp-3" : "block",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {prompt.text}
            </button>
          </div>
          {isLong && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setRowExpanded((v) => !v);
              }}
              className="mt-0.5 text-[11px] font-medium text-sky-300 hover:text-sky-200"
              aria-label={rowExpanded ? "Collapse queued prompt" : "Show full queued prompt"}
            >
              {rowExpanded ? "Show less" : "…"}
            </button>
          )}
          {prompt.attachments && prompt.attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5" data-testid="queued-attachments">
              {prompt.attachments.map((att, i) => (
                <span
                  key={`${att.name ?? att.kind}-${i}`}
                  className="flex items-center gap-1 rounded border border-sky-700/40 bg-sky-950/30 py-0.5 pl-0.5 pr-1.5 text-[10px] text-sky-200"
                  title={att.name ?? att.kind}
                >
                  {att.kind === "image" && att.dataB64 ? (
                    <img
                      src={`data:${att.mimeType};base64,${att.dataB64}`}
                      alt={att.name ?? "attachment"}
                      className="h-5 w-5 rounded object-cover"
                    />
                  ) : (
                    // No local bytes (a row hydrated from the server carries
                    // metadata only; the bytes live server-side and deliver on
                    // drain), so show a paperclip rather than a broken image.
                    <Paperclip className="h-3 w-3" />
                  )}
                  <span className="max-w-[100px] truncate">{att.name ?? att.kind}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {!editing && (
        <button
          type="button"
          onClick={onSendNow}
          disabled={!canSendNow}
          title={
            !canSendNow
              ? "Waiting to resume; this sends automatically once the session is back"
              : sendNowInterrupts
                ? "Stop the current turn and send this message now"
                : "Send this message now"
          }
          aria-label={
            sendNowInterrupts ? "Stop the current turn and send this queued message" : "Send this queued message now"
          }
          data-testid="queued-send-now"
          className="shrink-0 rounded p-1 text-sky-300 hover:bg-surface-800 hover:text-sky-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-sky-300"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Drop this queued message"
        className="shrink-0 rounded p-1 text-text-dim hover:bg-surface-800 hover:text-text-secondary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function QueuedPromptEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onSave(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSave(draft);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={Math.min(6, Math.max(1, draft.split("\n").length))}
        className={[
          "min-w-0 flex-1 resize-none bg-transparent text-xs leading-5",
          "text-text-primary outline-none placeholder:text-text-dim",
        ].join(" ")}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSave(draft)}
        title="Save (Enter)"
        className="shrink-0 rounded p-1 text-text-dim hover:bg-surface-800 hover:text-emerald-300"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
    </>
  );
}
>>>>>>> 0ce81e5c (refactor: isolate connection status publication)
