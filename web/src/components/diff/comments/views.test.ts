import { describe, expect, it } from "vitest";

import type { DiffView } from "../../../lib/diffViews";
import type { DiffComment } from "./types";
import { commentInView } from "./views";

const comment = (over: Partial<DiffComment>): DiffComment => ({
  id: "c",
  filePath: "a.ts",
  side: "new",
  startLine: 1,
  endLine: 1,
  body: "b",
  capturedSnippet: "x",
  createdAt: "2026-01-01T00:00:00Z",
  ...over,
});

const DEFAULT = undefined;
const OTHER_BASE: DiffView = { base: "layer" };
const RANGE: DiffView = { base: "main", head: "layer" };

describe("commentInView", () => {
  it.each<[string, Partial<DiffComment>, [boolean, boolean, boolean]]>([
    // (default view, another base, the range)
    ["a new-side working-tree comment", {}, [true, true, false]],
    ["an old-side comment on the session's base", { side: "old" }, [true, false, false]],
    ["an old-side comment on another base", { side: "old", base: "layer" }, [false, true, false]],
    ["a range comment", { range: { base: "main", head: "layer", headCommit: "abc" } }, [false, false, true]],
    ["a comment on another range", { range: { base: "layer", head: "top" } }, [false, false, false]],
  ])("places %s", (_, over, want) => {
    const c = comment(over);
    expect([commentInView(c, DEFAULT), commentInView(c, OTHER_BASE), commentInView(c, RANGE)]).toEqual(want);
  });
});
