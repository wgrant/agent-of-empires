import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RepoBase, RichDiffFile } from "../../lib/types";
import { sessionDiffRawFileUrl } from "../../lib/api";
import { buildDiffTree } from "../../lib/diffTree";
import { useWebSettings } from "../../hooks/useWebSettings";
import { viewFor, viewLabel, type DiffView } from "../../lib/diffViews";
import { BasePicker } from "./BasePicker";
import { FileContextMenu, type PathMenuState } from "./FileContextMenu";
import { useDiffViews } from "./DiffViewsContext";
import { Chevron, FlatList, LineCounts, TreeView } from "./DiffFileRows";

interface Props {
  files: RichDiffFile[];
  /** One entry per repo whose diff was computed. */
  perRepoBases: RepoBase[];
  warning: string | null;
  selectedPath: string | null;
  selectedRepoName: string | undefined;
  loading: boolean;
  onSelectFile: (path: string, repoName?: string) => void;
  /** With `repoPath`, enables the base-branch picker. */
  sessionId?: string | null;
  repoPath?: string | null;
  baseBranchOverride?: string | null;
  /** Called after the base changes so the parent refetches the diff. */
  onBaseBranchChanged?: () => void;
}

type ViewMode = "flat" | "tree";

function toggleIn(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

const sum = (files: RichDiffFile[], key: "additions" | "deletions") => files.reduce((n, f) => n + f[key], 0);

const CHIP = "font-mono text-[10px] px-1.5 py-px rounded bg-surface-800 text-text-muted";

export function DiffFileList({
  files,
  perRepoBases,
  warning,
  selectedPath,
  selectedRepoName,
  loading,
  onSelectFile,
  sessionId,
  repoPath,
  baseBranchOverride,
  onBaseBranchChanged,
}: Props) {
  const isMultiRepo = perRepoBases.length > 1;
  const singleBaseBranch = perRepoBases[0]?.base_branch ?? "main";
  const diffViews = useDiffViews();
  const singleView = diffViews ? viewFor(diffViews.views, perRepoBases[0]?.repo_name) : undefined;
  const singleError = isMultiRepo ? undefined : perRepoBases[0]?.error;
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(() => new Set());
  const { settings, update } = useWebSettings();
  const viewMode = settings.diffViewMode;
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set(settings.collapsedDiffDirs));
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [pathMenu, setPathMenu] = useState<PathMenuState | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const treeNodes = useMemo(() => buildDiffTree(files, collapsedDirs), [files, collapsedDirs]);

  useEffect(() => {
    update({ collapsedDiffDirs: [...collapsedDirs] });
  }, [collapsedDirs, update]);

  const toggleDir = useCallback((dirPath: string) => setCollapsedDirs((prev) => toggleIn(prev, dirPath)), []);

  const itemCount = viewMode === "tree" ? treeNodes.length : files.length;
  const clampedFocusedIndex = focusedIndex >= itemCount ? -1 : focusedIndex;

  const moveFocus = (step: 1 | -1) =>
    setFocusedIndex((prev) => {
      const next = step > 0 ? (prev < itemCount - 1 ? prev + 1 : prev) : prev > 0 ? prev - 1 : 0;
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
      return next;
    });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (itemCount === 0) return;
    const node = viewMode === "tree" ? treeNodes[clampedFocusedIndex] : undefined;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        moveFocus(e.key === "ArrowDown" ? 1 : -1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        // Right expands a collapsed dir, Left collapses an open one.
        if (node?.kind === "dir" && node.collapsed === (e.key === "ArrowRight")) {
          e.preventDefault();
          toggleDir(node.path);
        }
        break;
      case "Enter":
      case " ": {
        e.preventDefault();
        if (clampedFocusedIndex < 0) break;
        const flatFile = viewMode === "tree" ? undefined : files[clampedFocusedIndex];
        if (node?.kind === "dir") toggleDir(node.path);
        else if (node?.kind === "file") onSelectFile(node.file.path);
        else if (flatFile) onSelectFile(flatFile.path);
        break;
      }
    }
  };

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
      const path = row?.getAttribute("data-path");
      if (!row || !path) return; // Not on a row: keep the native menu.
      e.preventDefault();
      // Only file rows carry a repo, since workspace repos can share a path.
      const repo = row.getAttribute("data-repo");
      const file = repo === null ? undefined : files.find((f) => f.path === path && (f.repo_name ?? "") === repo);
      // A range's file opens as its head commit has it.
      const head = file && diffViews ? viewFor(diffViews.views, file.repo_name)?.head : undefined;
      const open =
        file && sessionId
          ? {
              url: sessionDiffRawFileUrl(sessionId, file.path, file.repo_name, head),
              disabled: file.status === "deleted",
            }
          : undefined;
      setPathMenu({ x: e.clientX, y: e.clientY, path, open });
    },
    [files, sessionId, diffViews],
  );
  const closePathMenu = useCallback(() => setPathMenu(null), []);

  const listProps = { selectedPath, selectedRepoName, onSelectFile };

  let body;
  if (loading && files.length === 0) {
    body = (
      <div className="flex items-center justify-center h-full text-text-dim">
        <span className="text-xs">Loading files...</span>
      </div>
    );
  } else if (isMultiRepo) {
    body = perRepoBases.map((repo) => (
      <RepoGroup
        key={repo.repo_name || "_default"}
        repo={repo}
        files={files.filter((f) => (f.repo_name ?? "") === (repo.repo_name ?? ""))}
        collapsed={collapsedRepos.has(repo.repo_name ?? "")}
        onToggle={() => setCollapsedRepos((prev) => toggleIn(prev, repo.repo_name ?? ""))}
        viewMode={viewMode}
        collapsedDirs={collapsedDirs}
        onToggleDir={toggleDir}
        sessionId={sessionId}
        onBaseBranchChanged={onBaseBranchChanged}
        {...listProps}
      />
    ));
  } else if (singleError) {
    body = <ViewError message={singleError} />;
  } else if (files.length === 0) {
    // Naming the base makes a clean tree read as checked, not broken.
    body = (
      <div className="flex items-center justify-center h-full text-text-dim text-xs">
        {singleView?.head ? "No changes in" : "No changes vs"}
        <span className="font-mono ml-1">
          {singleView?.head ? viewLabel(singleView, singleBaseBranch) : singleBaseBranch}
        </span>
      </div>
    );
  } else if (viewMode === "tree") {
    body = (
      <TreeView
        nodes={treeNodes}
        onToggleDir={toggleDir}
        focusedIndex={clampedFocusedIndex}
        onFocusIndex={setFocusedIndex}
        {...listProps}
      />
    );
  } else {
    body = <FlatList files={files} focusedIndex={clampedFocusedIndex} onFocusIndex={setFocusedIndex} {...listProps} />;
  }

  return (
    <div className="flex flex-col h-full bg-surface-900 overflow-hidden" onContextMenu={handleContextMenu}>
      <FileContextMenu menu={pathMenu} onClose={closePathMenu} />
      <div className="px-3 py-2 border-b border-surface-700/20 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[11px] uppercase tracking-wider text-text-dim">Changes</span>
          {isMultiRepo ? (
            <span className={CHIP}>{perRepoBases.length} repos</span>
          ) : singleView && diffViews ? (
            <ViewBadge
              view={singleView}
              base={singleBaseBranch}
              onReset={() => diffViews.clearView(perRepoBases[0]?.repo_name)}
            />
          ) : sessionId && repoPath ? (
            <BasePicker
              sessionId={sessionId}
              repoPath={repoPath}
              currentBase={singleBaseBranch}
              hasOverride={Boolean(baseBranchOverride)}
              onChanged={onBaseBranchChanged}
            />
          ) : (
            <span className={CHIP}>vs {singleBaseBranch}</span>
          )}
          {files.length > 0 && (
            <>
              <span className="font-mono text-[11px] text-text-muted">
                {files.length} file{files.length !== 1 ? "s" : ""}
              </span>
              <span className="font-mono text-[11px]">
                <span className="text-status-running">+{sum(files, "additions")}</span>{" "}
                <span className="text-status-error">-{sum(files, "deletions")}</span>
              </span>
              <button
                onClick={() => {
                  update({ diffViewMode: viewMode === "flat" ? "tree" : "flat" });
                  setFocusedIndex(-1);
                }}
                className="ml-auto shrink-0 p-1 rounded text-text-dim hover:text-text-muted hover:bg-surface-800/50 transition-colors cursor-pointer"
                title={viewMode === "flat" ? "Switch to tree view" : "Switch to flat list"}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path
                    d={
                      viewMode === "flat"
                        ? "M2 3h12M5 7h9M5 11h9M2 7l1.5 1L2 9M2 11l1.5 1L2 13"
                        : "M2 3h12M2 7h12M2 11h12"
                    }
                  />
                </svg>
              </button>
            </>
          )}
        </div>
        {warning && <p className="text-[11px] text-status-waiting mt-1">{warning}</p>}
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto" tabIndex={0} onKeyDown={handleKeyDown}>
        {body}
      </div>
    </div>
  );
}

// NUL cannot occur in a path, so it safely namespaces repo dirs in the shared collapsed set.
const REPO_NS_SEP = "\u0000";

function RepoGroup({
  repo,
  files,
  collapsed,
  onToggle,
  viewMode,
  collapsedDirs,
  onToggleDir,
  sessionId,
  onBaseBranchChanged,
  ...listProps
}: {
  repo: RepoBase;
  files: RichDiffFile[];
  collapsed: boolean;
  onToggle: () => void;
  viewMode: ViewMode;
  collapsedDirs: Set<string>;
  onToggleDir: (dirPath: string) => void;
  sessionId?: string | null;
  onBaseBranchChanged?: () => void;
  selectedPath: string | null;
  selectedRepoName: string | undefined;
  onSelectFile: (path: string, repoName?: string) => void;
}) {
  const name = repo.repo_name ?? "";
  const ns = `${name}${REPO_NS_SEP}`;
  const localCollapsed = useMemo(
    () => new Set([...collapsedDirs].filter((k) => k.startsWith(ns)).map((k) => k.slice(ns.length))),
    [collapsedDirs, ns],
  );
  const treeNodes = useMemo(
    () => (viewMode === "tree" ? buildDiffTree(files, localCollapsed) : []),
    [viewMode, files, localCollapsed],
  );
  const diffViews = useDiffViews();
  const view = diffViews ? viewFor(diffViews.views, repo.repo_name) : undefined;

  return (
    <div className="border-b border-surface-700/20 last:border-b-0">
      {/* A container, not one button, so the base picker is its own click target. */}
      <div className="w-full px-3 py-1.5 transition-colors flex items-center gap-1.5 bg-surface-850 hover:bg-surface-800 text-text-secondary">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="min-w-0 flex-1 text-left cursor-pointer flex items-center gap-1.5"
        >
          <Chevron collapsed={collapsed} />
          <span className="font-mono text-[12px] truncate">{repo.repo_name ?? "(default)"}</span>
        </button>
        {view && diffViews ? (
          <ViewBadge view={view} base={repo.base_branch} onReset={() => diffViews.clearView(repo.repo_name)} />
        ) : sessionId ? (
          <BasePicker
            sessionId={sessionId}
            repoPath={repo.repo_path}
            repoName={repo.repo_name}
            currentBase={repo.base_branch}
            hasOverride={Boolean(repo.base_override)}
            onChanged={onBaseBranchChanged}
          />
        ) : (
          <span className="font-mono text-[10px] text-text-dim">vs {repo.base_branch}</span>
        )}
        <span className="font-mono text-[11px] text-text-muted">{files.length}</span>
        <LineCounts additions={sum(files, "additions")} deletions={sum(files, "deletions")} />
      </div>
      {!collapsed && repo.error && <ViewError message={repo.error} />}
      {!collapsed && !repo.error && files.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-text-dim italic">No changes in this repo.</div>
      )}
      {!collapsed &&
        files.length > 0 &&
        (viewMode === "tree" ? (
          <TreeView
            nodes={treeNodes}
            onToggleDir={(p) => onToggleDir(`${ns}${p}`)}
            indentOffset={12}
            repoNameForSelect={name || undefined}
            {...listProps}
          />
        ) : (
          <FlatList files={files} indent="px-6" {...listProps} />
        ))}
    </div>
  );
}

/** The view this browser shows in place of the repo's default, with a way back. */
function ViewBadge({ view, base, onReset }: { view: DiffView; base: string; onReset: () => void }) {
  const title = view.head
    ? `What ${view.head} adds over ${view.base ?? base}, from where they forked. Shown in this browser only.`
    : `Compared with ${view.base ?? base} in this browser only; the session's base is unchanged.`;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid="diff-view-badge" title={title}>
      <span className="font-mono text-[10px] px-1.5 py-px rounded bg-brand-600/15 text-brand-500 truncate">
        {viewLabel(view, base)}
      </span>
      <button
        type="button"
        onClick={onReset}
        className="shrink-0 rounded px-1 text-[10px] text-text-dim hover:bg-surface-800 hover:text-text-secondary"
        aria-label="Back to the working tree diff"
        data-testid="diff-view-reset"
      >
        Working tree
      </button>
    </span>
  );
}

function ViewError({ message }: { message: string }) {
  return (
    <div role="alert" className="px-3 py-2 text-[11px] text-status-error" data-testid="diff-view-error">
      Can&apos;t show this diff: {message}
    </div>
  );
}
