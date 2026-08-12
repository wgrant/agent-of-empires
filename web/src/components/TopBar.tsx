import { useMemo } from "react";
import type { SessionResponse, Workspace } from "../lib/types";
import { PaletteTriggerPill } from "./PaletteTriggerPill";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { TOUR_ANCHORS, tourAnchor } from "../lib/tourSteps";
import { PluginStatusBarSegments } from "./plugin/PluginSlots";
import { ActivityBar } from "./ActivityBar";
import type { PaneDisplay } from "./Dock";
import { useWebSettings } from "../hooks/useWebSettings";
import { StrokeIcon } from "./icons";
import { usePublishedConnectionDiagnostics } from "../lib/connectionDiagnosticsContext";
import { useDashboardConnectionDiagnostics } from "../lib/connectionState";
import { GlobalConnectionStatusButton } from "./connection/ConnectionStatusView";
import type { ConnectionStatusSnapshot } from "./acp/status/connectionStatus";

interface Props {
  activeWorkspace: Workspace | undefined;
  activeSession: SessionResponse | null;
  /** Resolved project label from the same RepoGroup rendered by the sidebar,
   *  including any user-defined alias. */
  activeProjectName: string | null;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
  /** Mobile (below md): opens the view picker. The desktop activity bar uses
   *  `onTogglePane` instead. */
  onToggleDiff: () => void;
  /** All dockable pane ids (built-in + plugin) for the active session. */
  paneIds: string[];
  paneDescriptor: (id: string) => PaneDisplay;
  isPaneOpen: (id: string) => boolean;
  onTogglePane: (id: string) => void;
  onOpenHelp: () => void;
  onOpenAbout: () => void;
  onStartTutorial: () => void;
  onLogout: () => void;
  loginRequired: boolean;
  isOffline: boolean;
  /** When true, render a "DEV" badge (in the `status-waiting` amber) in the right-hand status zone so debug builds
   *  (port 8081 / `aoe_dev_` tmux / `~/.agent-of-empires-dev/`) are visually distinct from release builds at a
   *  glance, including in PWA installs where the port is not visible in the window chrome. */
  isDevBuild: boolean;
  /** Opens the tip-of-the-day modal; wired into the overflow menu so tips are
   *  re-readable any time, like GIMP/DBeaver's Help menu entry. */
  onOpenTips: () => void;
  onGoDashboard: () => void;
  /** When true (desktop, sidebar open, not in a full-width settings/projects view), the header's left zone widens
   *  to match the sidebar column and the divider runs vertically through the header instead of a bottom border, so
   *  the top-left of the header reads as part of the sidebar. */
  sidebarColumnVisible: boolean;
  /** Mirror of `sidebarColumnVisible` for the right side: when the right panel
   *  column is showing (desktop, active session, not collapsed), the header's
   *  right zone widens to match it and the divider runs up through the header. */
  rightColumnVisible: boolean;
}

export function TopBar({
  activeWorkspace,
  activeSession,
  activeProjectName,
  onToggleSidebar,
  onOpenPalette,
  onToggleDiff,
  paneIds,
  paneDescriptor,
  isPaneOpen,
  onTogglePane,
  onOpenHelp,
  onOpenAbout,
  onStartTutorial,
  onLogout,
  loginRequired,
  isOffline,
  isDevBuild,
  onOpenTips,
  onGoDashboard,
  sidebarColumnVisible,
  rightColumnVisible,
}: Props) {
  const overflowItems = useMemo<OverflowItem[]>(() => {
    const items: OverflowItem[] = [
      { label: "Help", onClick: onOpenHelp },
      { label: "Show tutorial", onClick: onStartTutorial },
      { label: "Tips", onClick: onOpenTips },
      { label: "About", onClick: onOpenAbout },
    ];
    if (loginRequired) items.push({ label: "Sign out", onClick: onLogout });
    return items;
  }, [onOpenHelp, onStartTutorial, onOpenTips, onOpenAbout, onLogout, loginRequired]);

  // The left zone only borrows the sidebar's width while that column is visible, so the compact rail only crowds
  // the wordmark in that combination.
  const { settings: webSettings } = useWebSettings();
  const hideWordmark = sidebarColumnVisible && webSettings.sidebarCompact;
  const hasSessionIdentity = activeProjectName !== null && activeSession !== null;
  const sessionIdentityLabel = hasSessionIdentity ? `${activeProjectName} / ${activeSession.title}` : undefined;
  const publishedDiagnostics = usePublishedConnectionDiagnostics(activeSession?.id ?? null);
  const dashboardConnection = useDashboardConnectionDiagnostics();
  const connectionSnapshot: ConnectionStatusSnapshot = {
    dashboard: isOffline ? { ...dashboardConnection, phase: "unavailable" } : dashboardConnection,
    session: publishedDiagnostics?.session ?? null,
  } as const;

  return (
    <header {...tourAnchor(TOUR_ANCHORS.topbar)} className="h-12 bg-surface-850 flex items-stretch shrink-0">
      {/* Left zone: widens to the sidebar column when it's visible so the divider runs vertically through the
         header instead of cutting across it; otherwise it keeps the shared bottom border like the rest. */}
      <div
        className={`flex items-center gap-2 px-3 min-w-0 shrink-0 border-b border-surface-700/60 ${
          sidebarColumnVisible ? "md:w-[var(--aoe-sidebar-width)] md:bg-surface-800 md:border-b-0 md:border-r" : ""
        }`}
      >
        <button
          onClick={onToggleSidebar}
          className="w-8 h-8 flex items-center justify-center cursor-pointer rounded-md transition-colors text-text-dim hover:text-text-secondary hover:bg-surface-700/50"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
        >
          <StrokeIcon size={16} strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </StrokeIcon>
        </button>

        <button
          onClick={onGoDashboard}
          className="flex items-center gap-1.5 min-w-0 text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
          aria-label="Go to dashboard"
        >
          <img src="/icon-192.png" alt="" width="18" height="18" className="rounded-sm shrink-0" />
          {/* This zone matches the sidebar column, so a compact rail leaves no
              room for the wordmark next to the toggle and the logo: it would sit
              flush against the divider and read as clipped. The logo alone still
              links to the dashboard. On a mobile session page the project and
              session identity takes the wordmark's space. See #2288. */}
          <span
            className={`font-mono text-xs leading-none truncate ${hasSessionIdentity ? "hidden sm:inline" : ""} ${
              hideWordmark ? "md:hidden" : ""
            }`}
          >
            aoe
          </span>
        </button>
      </div>

      {/* CENTER ZONE — session identity and desktop palette trigger; carries
          the bottom border across the middle between the column-aligned zones. */}
      <div className="flex-1 flex items-center px-3 min-w-0 border-b border-surface-700/60">
        {hasSessionIdentity && (
          <div
            className="sm:hidden flex-1 min-w-0 flex flex-col justify-center font-mono"
            title={sessionIdentityLabel}
            aria-label={`Current session: ${sessionIdentityLabel}`}
            data-testid="topbar-session-identity-mobile"
          >
            <span className="text-[10px] leading-3 text-text-dim truncate">{activeProjectName}</span>
            <span className="text-xs leading-4 text-text-secondary truncate">{activeSession.title}</span>
          </div>
        )}
        {hasSessionIdentity && (
          <div
            className="hidden sm:flex flex-1 min-w-0 items-center gap-1.5 text-xs font-mono"
            title={sessionIdentityLabel}
            aria-label={`Current session: ${sessionIdentityLabel}`}
            data-testid="topbar-session-identity-desktop"
          >
            <span className="max-w-[35%] truncate text-text-muted">{activeProjectName}</span>
            <span className="shrink-0 text-text-dim">/</span>
            <span className="min-w-0 truncate text-text-secondary">{activeSession.title}</span>
          </div>
        )}
        <div className={`${hasSessionIdentity ? "hidden sm:flex" : "flex"} flex-1 justify-center px-2 min-w-0`}>
          <PaletteTriggerPill onClick={onOpenPalette} showMobile={!hasSessionIdentity} />
        </div>
      </div>

      {/* Right zone: widens to the right-panel column when it's visible so the divider runs vertically through
         the header instead of cutting across it; otherwise it keeps the shared bottom border like the rest. */}
      <div
        className={`flex items-center justify-end gap-1.5 px-3 shrink-0 border-b border-surface-700/60 ${
          rightColumnVisible ? "md:w-[var(--aoe-right-panel-width)] md:border-b-0 md:border-l" : ""
        }`}
      >
        <PluginStatusBarSegments />
        {isDevBuild && (
          <span
            className="font-mono text-[11px] px-1.5 py-0.5 rounded-full bg-status-waiting/15 text-status-waiting ring-1 ring-status-waiting/30"
            title="Debug build (cfg!(debug_assertions)); distinguishes the dev instance from a concurrent release build. See issue #1055."
            aria-label="Debug build"
          >
            DEV
          </span>
        )}
        <GlobalConnectionStatusButton
          snapshot={connectionSnapshot}
          onReconnect={publishedDiagnostics?.onReconnect}
          incidentVisible={publishedDiagnostics?.incidentVisible ?? true}
        />

        {hasSessionIdentity && <PaletteTriggerPill onClick={onOpenPalette} showDesktop={false} />}

        {activeWorkspace && activeSession && (
          <>
            {/* Desktop: per-pane toggles. */}
            <ActivityBar paneIds={paneIds} descriptorFor={paneDescriptor} isOpen={isPaneOpen} onToggle={onTogglePane} />
            <button
              onClick={onToggleDiff}
              className="md:hidden w-8 h-8 flex items-center justify-center cursor-pointer rounded-md transition-colors text-text-secondary hover:text-text-primary hover:bg-surface-700/50"
              title="Toggle panels"
              aria-label="Toggle panels"
            >
              <StrokeIcon size={16} strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </StrokeIcon>
            </button>
          </>
        )}

        <OverflowMenu items={overflowItems} triggerDataTour={TOUR_ANCHORS.topbarMore} />
      </div>
    </header>
  );
}
