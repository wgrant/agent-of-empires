// Bridges the ACP session store (useAcpSession) to assistant-ui's external-store
// runtime. assistant-ui renders the thread; we own the data and the actions.

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";

import { useAcpSession } from "../../hooks/useAcpSession";
import { useHistoryWindow } from "../../hooks/useHistoryWindow";
import { clearDraft, getDraftAttachments, setDraftAttachments } from "../../lib/acpDrafts";
import { isVisiblyBusy } from "../../lib/acpTypes";
import type { AcpState, ApprovalDecision, ElicitationResolution, PromptAttachmentInput } from "../../lib/acpTypes";
import { useAgentProfile } from "../../lib/agentProfileContext";
import { canOfferEarlier, earlierAction } from "../../lib/historyScroll";
import { activityToThreadMessages, clearFoldGeneration } from "./activityMessages";
import { useCancelEscalation } from "./useCancelEscalation";

type Session = ReturnType<typeof useAcpSession>;

/** A viewport position captured before navigating the bounded transcript.
 * This belongs above the keyed assistant-ui runtime: navigation deliberately
 * remounts that runtime to dispose index-based resources, but the replacement
 * view must still restore the reader's position after it mounts. */
export interface HistoryScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
  publishedGeneration: number;
}

/** Navigation controls must survive a keyed assistant-ui replacement. A
 * replacement can itself emit a scroll event; treating that as a fresh user
 * arrival at the top chains history loads and leaves the reader at seemingly
 * random positions. */
export interface HistoryNavigationController {
  autoLoadArmed: boolean;
  lastLoadAt: number;
  restoringScroll: boolean;
}

interface Props {
  sessionId: string;
  /** Archived and snoozed sessions auto-wake on send. */
  archivedAt?: string | null;
  snoozedUntil?: string | null;
  /** Render rows before the latest `/clear` instead of folding them. */
  showClearedTurns?: boolean;
  children: (ctx: AcpContext) => ReactNode;
}

export interface AcpContext {
  state: AcpState;
  status: Session["status"];
  serverReachability: Session["serverReachability"];
  lastWebSocketOpenAt: Session["lastWebSocketOpenAt"];
  lastServerMessageAt: Session["lastServerMessageAt"];
  lastTransportDiagnostic: Session["lastTransportDiagnostic"];
  reconnectingSince: Session["reconnectingSince"];
  liveUpdatesStale: Session["liveUpdatesStale"];
  hasEverOpened: boolean;
  /** The auto-reconnect backoff is armed between a close and the next dial. */
  reconnecting: boolean;
  retryCount: number;
  retryCountdown: number;
  maxRetries: number;
  manualReconnect: () => void;
  resolveApproval: (nonce: string, decision: ApprovalDecision, optionId?: string) => Promise<void>;
  resolveElicitation: (nonce: string, resolution: ElicitationResolution) => Promise<void>;
  sendPrompt: (text: string, attachments?: PromptAttachmentInput[]) => Promise<void>;
  /** Staged for the next send; owned here so assistant-ui's `onNew` can send them. */
  pendingAttachments: PromptAttachmentInput[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<PromptAttachmentInput[]>>;
  forceEndTurn: () => Promise<void>;
  lastActivityRef: Session["lastActivityRef"];
  dismissError: () => void;
  dismissPrimer: () => void;
  dismissCompactionReminder: () => void;
  removeQueuedPrompt: (id: string) => void;
  editQueuedPrompt: (id: string, text: string) => void;
  clearQueue: () => void;
  sendQueuedNow: Session["sendQueuedNow"];
  dismissRejectedPrompt: (id: string) => void;
  dismissModeSwitchFailed: () => void;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  dismissConfigOptionSwitchFailed: () => void;
  /** Older rows exist above the window, loaded or still on the server. */
  canLoadEarlierHistory: boolean;
  /** Reveal loaded older rows first, then fetch the next page. */
  loadEarlierHistory: () => void;
  canLoadNewerHistory: boolean;
  loadNewerHistory: () => void;
  jumpToLatestHistory: () => void;
  /** Increments whenever assistant-ui is replaced with a different bounded
   * transcript range. Lets the viewport restore an explicit history anchor
   * after that runtime is mounted. */
  publishedTranscriptGeneration: number;
  /** Stable across assistant-ui runtime replacement. The view stores an
   * explicit older-history scroll anchor here and consumes it once the next
   * transcript publication has mounted. */
  historyScrollAnchorRef: MutableRefObject<HistoryScrollAnchor | null>;
  historyNavigationControllerRef: MutableRefObject<HistoryNavigationController>;
  loadingEarlierHistory: boolean;
  replaySyncing: boolean;
}

/** Owns the external store so a new `key` builds a fresh runtime. A `/clear`
 *  shortens a kept message's parts, and assistant-ui's store would otherwise read
 *  a stale part index and crash the view (assistant-ui#5708). */
function RuntimeHost({ adapter, children }: { adapter: ExternalStoreAdapter<ThreadMessageLike>; children: ReactNode }) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** Staged attachments persisted per session, with a ref mirror for `onNew`. */
function usePendingAttachments(sessionId: string) {
  // The view remounts per session, so the initializer seeds the right draft once.
  const [pendingAttachments, setPendingAttachments] = useState<PromptAttachmentInput[]>(() =>
    getDraftAttachments(sessionId),
  );
  const pendingAttachmentsRef = useRef<PromptAttachmentInput[]>(pendingAttachments);
  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);
  // Skip the first run: re-serializing the just-loaded base64 would be wasted work.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    setDraftAttachments(sessionId, pendingAttachments);
  }, [sessionId, pendingAttachments]);
  return { pendingAttachments, setPendingAttachments, pendingAttachmentsRef };
}

export function AcpRuntime({
  sessionId,
  archivedAt = null,
  snoozedUntil = null,
  showClearedTurns = false,
  children,
}: Props) {
  const acp = useAcpSession(sessionId, archivedAt, snoozedUntil);
  const agentProfile = useAgentProfile();
  const { pendingAttachments, setPendingAttachments, pendingAttachmentsRef } = usePendingAttachments(sessionId);
  const onCancel = useCancelEscalation(
    sessionId,
    acp.state.promptSeq,
    acp.state.cancelling,
    acp.cancelPrompt,
    acp.forceEndTurn,
  );
  // Render only the most recent slice of the transcript so a long
  // session does not block first paint on mobile; older rows stay in
  // reducer state and are revealed via "Load earlier". Before the first
  // WebSocket open, a warm-cache replay re-anchors this remembered depth
  // at the fresh tail. Later live appends preserve the current start.
  // See #2144 and #2236.
  const {
    windowedActivity,
    canLoadEarlier,
    canLoadNewer,
    loadEarlier,
    loadNewer,
    jumpToLatest,
    generation: historyGeneration,
  } = useHistoryWindow(sessionId, acp.state.activity, showClearedTurns, acp.hasEverOpened);
  const { loadOlder, hasMoreOlder, loadingOlder } = acp;
  const loadEarlierHistory = useCallback(() => {
    const action = earlierAction(canLoadEarlier, hasMoreOlder);
    if (action === "reveal") loadEarlier();
    else if (action === "fetch") void loadOlder();
  }, [canLoadEarlier, hasMoreOlder, loadEarlier, loadOlder]);

  // Optimistic rows append until their server row (by id, in the full activity) lands.
  const displayActivity = useMemo(() => {
    const optimistic = acp.state.optimisticRows;
    if (optimistic.length === 0) return windowedActivity;
    const serverIds = new Set(acp.state.activity.map((r) => r.id));
    const pending = optimistic.filter((o) => !serverIds.has(o.id));
    return pending.length > 0 ? windowedActivity.concat(pending) : windowedActivity;
  }, [windowedActivity, acp.state.optimisticRows, acp.state.activity]);
  const visiblyBusy = isVisiblyBusy(acp.state);

  // assistant-ui resources retain indexes into their message store. Replace
  // the provider whenever bounded history navigation moves to a different
  // index space, while ordinary live updates keep the existing runtime.
  const historyScrollAnchorRef = useRef<HistoryScrollAnchor | null>(null);
  const historyNavigationControllerRef = useRef<HistoryNavigationController>({
    autoLoadArmed: true,
    lastLoadAt: 0,
    restoringScroll: false,
  });
  // Memoise the activity → ThreadMessageLike conversion. The function
  // walks the activity array, allocates a new AssistantBuilder
  // per turn, and produces brand-new message objects. Without
  // useMemo, every parent re-render (e.g. WS heartbeat, hover state)
  // re-builds the transcript and assistant-ui treats every
  const messages = useMemo(
    () =>
      activityToThreadMessages(
        displayActivity,
        visiblyBusy,
        showClearedTurns,
        agentProfile.capabilities.todos,
        agentProfile,
      ),
    [displayActivity, visiblyBusy, showClearedTurns, agentProfile],
  );
  const foldGeneration = useMemo(
    () => clearFoldGeneration(displayActivity, showClearedTurns),
    [displayActivity, showClearedTurns],
  );

  const adapter: ExternalStoreAdapter<ThreadMessageLike> = {
    messages,
    // NOT visiblyBusy: assistant-ui's own ComposerInput swallows Enter
    // outright when isRunning is true and the adapter has no queue
    // capability (`if (threadState.isRunning && !hasQueue) return;`), so this
    // has to track only the main turn, exactly like Composer.tsx's turnActive
    // gate, or a background sub-agent with an idle main turn silently eats
    // every keystroke.
    isRunning: acp.state.turnActive,
    convertMessage: (m) => m,
    // The idle Enter path: text comes from the message, attachments from our staging.
    onNew: async (msg) => {
      const text = msg.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("")
        .trim();
      const attachments = [...pendingAttachmentsRef.current];
      if (!text && attachments.length === 0) return;
      // Clear drafts before awaiting: an unmount mid-send must not rehydrate what was sent.
      clearDraft(sessionId);
      pendingAttachmentsRef.current = [];
      setDraftAttachments(sessionId, []);
      setPendingAttachments([]);
      await acp.sendPrompt(text, attachments);
    },
    onCancel,
  };

  return (
    <RuntimeHost key={`${foldGeneration}:${historyGeneration}`} adapter={adapter}>
      {children({
        state: acp.state,
        status: acp.status,
        serverReachability: acp.serverReachability,
        lastWebSocketOpenAt: acp.lastWebSocketOpenAt,
        lastServerMessageAt: acp.lastServerMessageAt,
        lastTransportDiagnostic: acp.lastTransportDiagnostic,
        reconnectingSince: acp.reconnectingSince,
        liveUpdatesStale: acp.liveUpdatesStale,
        hasEverOpened: acp.hasEverOpened,
        reconnecting: acp.reconnecting,
        retryCount: acp.retryCount,
        retryCountdown: acp.retryCountdown,
        maxRetries: acp.maxRetries,
        manualReconnect: acp.manualReconnect,
        resolveApproval: acp.resolveApproval,
        resolveElicitation: acp.resolveElicitation,
        sendPrompt: acp.sendPrompt,
        pendingAttachments,
        setPendingAttachments,
        forceEndTurn: acp.forceEndTurn,
        lastActivityRef: acp.lastActivityRef,
        dismissError: acp.dismissError,
        dismissPrimer: acp.dismissPrimer,
        dismissCompactionReminder: acp.dismissCompactionReminder,
        removeQueuedPrompt: acp.removeQueuedPrompt,
        editQueuedPrompt: acp.editQueuedPrompt,
        clearQueue: acp.clearQueue,
        sendQueuedNow: acp.sendQueuedNow,
        dismissRejectedPrompt: acp.dismissRejectedPrompt,
        dismissModeSwitchFailed: acp.dismissModeSwitchFailed,
        setConfigOption: acp.setConfigOption,
        dismissConfigOptionSwitchFailed: acp.dismissConfigOptionSwitchFailed,
        canLoadEarlierHistory: canOfferEarlier(canLoadEarlier, hasMoreOlder),
        loadEarlierHistory,
        canLoadNewerHistory: canLoadNewer,
        loadNewerHistory: loadNewer,
        jumpToLatestHistory: jumpToLatest,
        publishedTranscriptGeneration: historyGeneration,
        historyScrollAnchorRef,
        historyNavigationControllerRef,
        loadingEarlierHistory: loadingOlder,
        replaySyncing: acp.replaySyncing,
      })}
    </RuntimeHost>
  );
}
