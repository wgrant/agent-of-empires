export type DiffSide = "old" | "new";

/** A review comment on a line range of one diff side. */
export interface DiffComment {
  id: string;
  /** Workspace member name; undefined for single-repo sessions. */
  repoName?: string;
  filePath: string;
  side: DiffSide;
  /** Inclusive, 1-based. */
  startLine: number;
  /** Inclusive, >= startLine. */
  endLine: number;
  /** Markdown. */
  body: string;
  /** Code as the reviewer saw it, so the prompt stays meaningful after the diff moves. */
  capturedSnippet: string;
  language?: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt?: string;
  /** The commit range it was made on; its lines are then `head`'s, not the working tree's. */
  range?: DiffCommentRange;
  /** The base an old-side comment was made against, when the view showed another than the session's. */
  base?: string;
}

/** Commits are absent on comments made before they were recorded. */
export interface DiffCommentRange {
  base: string;
  head: string;
  /** The commit `head` named when the comment was made. */
  headCommit?: string;
  /** The merge-base the range diffed from. */
  fromCommit?: string;
  /** Whether the worktree had `head` checked out then. */
  headCheckedOut?: boolean;
}

export type DiffCommentDraft = Omit<DiffComment, "id" | "createdAt">;

/** Versioned localStorage envelope; other versions are dropped on load. */
export interface DiffCommentsStorageV1 {
  version: 1;
  comments: DiffComment[];
  clearAfterSend: boolean;
  introDraft: string;
  outroDraft: string;
}

export interface AnchoredComment {
  comment: DiffComment;
  status: "active" | "stale";
}
