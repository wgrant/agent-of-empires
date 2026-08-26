import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyAcpState, type AcpFrame, type TranscriptRow } from "../../lib/acpTypes";
import type { Action } from "./reducer";
import { fetchOlderPage, fetchReplay } from "./replay";
import { cacheSet, clearAcpCache } from "./stateCache";

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
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAcpCache();
  });

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

  it("replaces an enormous warm delta with a bounded recent tail", async () => {
    const sid = "sess-stale-cache";
    cacheSet(sid, {
      ...emptyAcpState(),
      lastSeq: 100,
      queuedPrompts: [{ id: "consumed", text: "continue", queuedAt: "2026-01-01T00:00:00Z", pending: false }],
    });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const query = new URL(input.toString(), "http://x").searchParams;
        requests.push(query.has("before") ? `tail:${query.get("view") ?? "frames"}` : `since:${query.get("since")}`);
        const rows = query.get("view") === "rows";
        if (query.has("before")) {
          return new Response(
            JSON.stringify({
              frames: rows ? [] : [promptFrame(sid, 50_100)],
              rows: rows ? [prompt(50_100)] : undefined,
              lost: false,
              highest_seq: 50_100,
              next_cursor: 49_100,
              has_more: true,
            }),
          );
        }
        return new Response(
          JSON.stringify({ frames: [], rows: rows ? [] : undefined, lost: false, highest_seq: 50_100 }),
        );
      }),
    );
    const actions: Action[] = [];
    const lastSeq = { current: 100 };

    await fetchReplay(sid, lastSeq, (action) => actions.push(action), vi.fn());

    expect(requests).toEqual(["since:50", "since:50", "tail:frames", "tail:rows", "since:0"]);
    expect(actions.map((action) => action.kind)).toEqual(["hydrate", "frames", "lagged_resolved"]);
    expect(actions[0]).toMatchObject({ kind: "hydrate", state: { queuedPrompts: [] } });
    expect(lastSeq.current).toBe(50_100);
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
