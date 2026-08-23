import { afterEach, describe, expect, it, vi } from "vitest";

import type { AcpFrame, TranscriptRow } from "../../lib/acpTypes";
import type { Action } from "./reducer";
import { fetchOlderPage, fetchReplay } from "./replay";

const prompt = (seq: number): TranscriptRow => ({
  id: `user-seq-${seq}`,
  group_id: `g-${seq}`,
  kind: "user_prompt",
  at: "2026-01-01T00:00:00Z",
  text: `prompt ${seq}`,
});

const promptFrame = (sessionId: string, seq: number): AcpFrame => ({
  session_id: sessionId,
  seq,
  event: { UserPromptSent: { text: `prompt ${seq}` } },
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("fetchReplay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes a warm-cache catch-up only after every page arrives", async () => {
    const sid = "sess-atomic-catchup";
    let releaseSecondPage!: () => void;
    const secondPage = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const query = new URL(input.toString(), "http://x").searchParams;
        const since = query.get("since")!;
        const rows = query.get("view") === "rows";
        if (since === "2") await secondPage;
        const first = since === "0";
        return new Response(
          JSON.stringify({
            frames: rows ? [] : first ? [promptFrame(sid, 1), promptFrame(sid, 2)] : [promptFrame(sid, 3)],
            rows: rows ? (first ? [prompt(1), prompt(2)] : [prompt(3)]) : undefined,
            lost: false,
            highest_seq: 3,
            next_cursor: first ? 2 : 3,
            has_more: first,
          }),
          { status: 200 },
        );
      }),
    );
    const actions: Action[] = [];
    const lastSeq = { current: 1 };

    const replay = fetchReplay(sid, lastSeq, (action) => actions.push(action), vi.fn());
    await flush();
    expect(actions).toEqual([]);
    expect(lastSeq.current).toBe(1);

    releaseSecondPage();
    await replay;

    expect(actions).toEqual([
      expect.objectContaining({ kind: "catchup", reset: false, frames: expect.arrayContaining([]) }),
    ]);
    expect(actions[0]).toMatchObject({
      rows: [{ id: "user-seq-1" }, { id: "user-seq-2" }, { id: "user-seq-3" }],
    });
    expect(lastSeq.current).toBe(3);
  });
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
