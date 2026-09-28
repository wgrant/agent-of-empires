import { extractSnippetFromContents } from "./extractSnippetFromContents";
import type { AnchoredComment, DiffComment } from "./types";
import { headMoved } from "./views";

/** A comment is active while its range still fits its side of the file, stale
 *  otherwise, and stale outright when the range's head now names another commit
 *  than the one it was made on: its line numbers could land on other lines. */
export function anchorCommentsToContents(
  comments: DiffComment[],
  filePath: string,
  repoName: string | undefined,
  oldContent: string,
  newContent: string,
  headCommit?: string,
): AnchoredComment[] {
  return comments
    .filter((c) => c.filePath === filePath && (c.repoName ?? undefined) === (repoName ?? undefined))
    .map((c) => ({
      comment: c,
      status:
        headMoved(c, headCommit) ||
        extractSnippetFromContents(oldContent, newContent, c.side, c.startLine, c.endLine) == null
          ? "stale"
          : "active",
    }));
}
