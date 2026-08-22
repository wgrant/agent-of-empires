import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptRow } from "../../lib/acpTypes";
import type { Action } from "./reducer";
import { fetchOlderPage } from "./replay";

const prompt = (seq: number): TranscriptRow => ({
  id: `user-seq-${seq}`,
  group_id: `g-${seq}`,
  kind: "user_prompt",
  at: "2026-01-01T00:00:00Z",
  text: `prompt ${seq}`,
});

describe("fetchOlderPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("advances through empty folded pages before prepending older rows", async () => {
    const requestedBefore: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const before = new URL(input.toString(), "http://x").searchParams.get("before")!;
        requestedBefore.push(before);
        const body =
          before === "8"
            ? { rows: [], next_cursor: 6, has_more: true }
            : { rows: [prompt(3), prompt(4)], next_cursor: 3, has_more: true };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const actions: Action[] = [];

    const more = await fetchOlderPage("sess-empty-page", 8, (action) => actions.push(action));

    expect(requestedBefore).toEqual(["8", "6"]);
    expect(more).toBe(true);
    expect(actions).toEqual([
      expect.objectContaining({ kind: "prepend", oldestSeq: 3, rows: expect.arrayContaining([]) }),
    ]);
    expect(actions[0]).toMatchObject({
      rows: [{ id: "user-seq-3" }, { id: "user-seq-4" }],
    });
  });
});
