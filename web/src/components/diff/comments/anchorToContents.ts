import { extractSnippetFromContents } from "./extractSnippetFromContents";
import type { AnchoredComment, DiffComment } from "./types";
import { rangeMoved, type ViewCommits } from "./views";

/** A comment is active while its range still fits its side of the file, stale
 *  otherwise, and stale outright when its side of a range now comes from
 *  another commit than it was made on: its line numbers could land on other lines. */
export function anchorCommentsToContents(
  comments: DiffComment[],
  filePath: string,
  repoName: string | undefined,
  oldContent: string,
  newContent: string,
  commits?: ViewCommits,
): AnchoredComment[] {
  return comments
    .filter((c) => c.filePath === filePath && (c.repoName ?? undefined) === (repoName ?? undefined))
    .map((c) => ({
      comment: c,
      status:
        rangeMoved(c, commits) ||
        extractSnippetFromContents(oldContent, newContent, c.side, c.startLine, c.endLine) == null
          ? "stale"
          : "active",
    }));
}
