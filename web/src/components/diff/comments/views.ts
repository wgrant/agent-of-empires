// Which diff view a comment was made in: the working tree against the
// session's base, the working tree against another base, or a commit range.

import type { DiffView } from "../../../lib/diffViews";
import type { DiffComment } from "./types";

const shortSha = (sha: string) => sha.slice(0, 7);

/** Whether `comment` belongs on `view` (undefined for the default view). A
 *  new-side comment on another base shares the working tree with the default
 *  view; an old-side one belongs to the base it was made against. */
export function commentInView(comment: DiffComment, view: DiffView | undefined): boolean {
  if (comment.range) {
    return view?.head === comment.range.head && view.base === comment.range.base;
  }
  if (view?.head) return false;
  if (comment.side === "new") return true;
  return (comment.base ?? undefined) === (view?.base ?? undefined);
}

/** The view a comment was made in, as the prompt and send dialog name it. */
export function commentViewLabel(comment: DiffComment): string {
  const { range } = comment;
  if (range) {
    const at = range.headCommit ? ` at \`${shortSha(range.headCommit)}\`` : "";
    const from = range.fromCommit ? `, from merge-base \`${shortSha(range.fromCommit)}\`` : "";
    const elsewhere = range.headCheckedOut === false ? `; \`${range.head}\` is not checked out in this worktree` : "";
    return `${comment.side} side of \`${range.base}...${range.head}\`${at}${from}${elsewhere}`;
  }
  if (comment.side === "old") {
    return comment.base ? `old side, against \`${comment.base}\`` : "old side, against the session's base";
  }
  return "new side, working tree";
}

/** Whether a range comment's `head` has moved since it was made, so its line
 *  numbers may name other lines. A comment without a recorded commit, or a view
 *  whose commit is not known yet, cannot tell. */
export function headMoved(comment: DiffComment, headCommit: string | undefined): boolean {
  const made = comment.range?.headCommit;
  return made !== undefined && headCommit !== undefined && made !== headCommit;
}
