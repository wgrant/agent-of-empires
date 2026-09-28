import { describe, expect, it } from "vitest";

import { parseDiffTarget, viewFor, viewLabel, viewMatches, viewsParam, withView, withoutView } from "./diffViews";

describe("diff views", () => {
  it.each<[string, unknown, ReturnType<typeof parseDiffTarget>]>([
    ["a range", { base: "main", head: "layer" }, { base: "main", head: "layer" }],
    ["a base alone", { base: " main " }, { base: "main" }],
    ["a repo", { repo: "api", base: "main", head: "a1b2" }, { repo: "api", base: "main", head: "a1b2" }],
    ["no base", { head: "layer" }, null],
    ["an empty base", { base: "  " }, null],
    ["a control character", { base: "main", head: "la\u0000yer" }, null],
    ["an overlong ref", { base: "x".repeat(257) }, null],
    ["a non-string repo", { repo: 3, base: "main" }, null],
    ["not an object", "main..layer", null],
  ])("reads %s as a diff target", (_, value, want) => {
    expect(parseDiffTarget(value)).toEqual(want);
  });

  it("keeps one view per repo and matches a target exactly", () => {
    let views = withView([], { repo: "api", base: "main", head: "layer" });
    views = withView(views, { repo: "web", base: "main" });
    views = withView(views, { repo: "api", base: "layer", head: "top" });
    expect(views).toEqual([
      { repo: "web", base: "main" },
      { repo: "api", base: "layer", head: "top" },
    ]);
    const api = viewFor(views, "api");
    expect(viewMatches(api, { base: "layer", head: "top" })).toBe(true);
    expect(viewMatches(api, { base: "layer" })).toBe(false);
    expect(viewMatches(viewFor(views, "web"), { base: "main" })).toBe(true);
    expect(viewMatches(undefined, { base: "main" })).toBe(false);
    expect(withoutView(views, "api")).toEqual([{ repo: "web", base: "main" }]);
  });

  it("encodes views for the file list and labels them", () => {
    expect(viewsParam([])).toBeNull();
    expect(JSON.parse(viewsParam([{ base: "main", head: "layer" }])!)).toEqual([{ base: "main", head: "layer" }]);
    expect(viewLabel({ base: "main", head: "layer" }, "origin/main")).toBe("main...layer");
    expect(viewLabel({ base: "layer" }, "main")).toBe("vs layer");
    expect(viewLabel({ head: "layer" }, "main")).toBe("main...layer");
  });
});
