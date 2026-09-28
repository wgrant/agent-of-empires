import { describe, it, expect } from "vitest";
import { anchorCommentsToContents } from "./anchorToContents";
import type { DiffComment } from "./types";

const OLD = "old1\nold2\nold3\n";
const NEW = "new1\nnew2\nnew3\nnew4\n";

function comment(over: Partial<DiffComment>): DiffComment {
  return {
    id: "c1",
    filePath: "a.ts",
    side: "new",
    startLine: 1,
    endLine: 2,
    body: "b",
    capturedSnippet: "new1\nnew2",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("anchorCommentsToContents", () => {
  it("marks in-bounds comments active and out-of-bounds ranges stale", () => {
    const out = anchorCommentsToContents(
      [comment({ id: "in" }), comment({ id: "out", side: "old", startLine: 3, endLine: 5 })],
      "a.ts",
      undefined,
      OLD,
      NEW,
    );
    expect(out.map((a) => a.status)).toEqual(["active", "stale"]);
  });

  it("filters by filePath and repoName", () => {
    const comments = [
      comment({ id: "keep" }),
      comment({ id: "wrong-file", filePath: "b.ts" }),
      comment({ id: "wrong-repo", repoName: "other" }),
    ];
    const out = anchorCommentsToContents(comments, "a.ts", undefined, OLD, NEW);
    expect(out.map((a) => a.comment.id)).toEqual(["keep"]);
  });
});

describe("a range comment whose commits moved", () => {
  const range = { base: "main", head: "layer", headCommit: "h1", fromCommit: "f1" };
  const legacy = { base: "main", head: "layer" };
  it.each<[string, Partial<DiffComment>, { head: string; from: string } | undefined, "active" | "stale"]>([
    ["a new-side comment on the same commits", { range }, { head: "h1", from: "f1" }, "active"],
    ["a new-side comment after head moved", { range }, { head: "h2", from: "f1" }, "stale"],
    ["a new-side comment when only the merge-base moved", { range }, { head: "h1", from: "f2" }, "active"],
    [
      "an old-side comment after the merge-base moved",
      { range, side: "old", startLine: 1, endLine: 1 },
      { head: "h1", from: "f2" },
      "stale",
    ],
    [
      "an old-side comment when only head moved",
      { range, side: "old", startLine: 1, endLine: 1 },
      { head: "h2", from: "f1" },
      "active",
    ],
    ["a comment made before commits were recorded", { range: legacy }, { head: "h2", from: "f2" }, "active"],
    ["a comment in a view whose commits are not known yet", { range }, undefined, "active"],
  ])("is %s", (_, over, now, status) => {
    const out = anchorCommentsToContents([comment(over)], "a.ts", undefined, OLD, NEW, now);
    expect(out.map((a) => a.status)).toEqual([status]);
  });
});
