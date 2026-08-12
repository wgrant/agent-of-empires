// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";

import type { ActivityRow } from "../../lib/acpTypes";
import { DEFAULT_HISTORY_WINDOW } from "../../lib/acpHistoryWindow";
import { clearRememberedHistoryWindows, MAX_HISTORY_WINDOW, useHistoryWindow } from "../useHistoryWindow";

beforeEach(() => clearRememberedHistoryWindows());

function transcript(turns: number, perTurn: number): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (let t = 0; t < turns; t += 1) {
    rows.push({ id: `u-${t}`, kind: "user_prompt", text: `prompt ${t}` });
    for (let r = 0; r < perTurn; r += 1) rows.push({ id: `m-${t}-${r}`, kind: "message", text: `msg ${t}.${r}` });
  }
  return rows;
}

describe("useHistoryWindow", () => {
  it("windows a long transcript and offers Load earlier", () => {
    const activity = transcript(100, 1); // 200 rows
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW);
    expect(result.current.windowedActivity.length).toBeLessThan(activity.length);
    expect(result.current.canLoadEarlier).toBe(true);
  });

  it("renders everything and hides the control for a short transcript", () => {
    const activity = transcript(3, 1); // 6 rows
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));
    expect(result.current.windowedActivity).toHaveLength(activity.length);
    expect(result.current.canLoadEarlier).toBe(false);
  });

  it("tail-anchors a transcript that arrives in one initial batch", () => {
    const activity = transcript(100, 1);
    const { result, rerender } = renderHook(({ rows }) => useHistoryWindow("s1", rows, false), {
      initialProps: { rows: [] as ActivityRow[] },
    });

    rerender({ rows: activity });

    expect(result.current.windowedActivity.at(-1)?.id).toBe("m-99-0");
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW);
  });

  it("loadEarlier grows the window until the whole transcript shows", () => {
    const activity = transcript(100, 1); // 200 rows
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));
    for (let i = 0; i < 5 && result.current.canLoadEarlier; i += 1) {
      act(() => result.current.loadEarlier());
    }
    expect(result.current.windowedActivity).toHaveLength(activity.length);
    expect(result.current.canLoadEarlier).toBe(false);
  });

  it("moves through a large transcript in bounded ranges with a newer navigator", () => {
    const activity = transcript(1000, 1); // 2,000 rows
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));

    for (let i = 0; i < 8; i += 1) {
      act(() => result.current.loadEarlier());
      expect(result.current.windowedActivity.length).toBeLessThanOrEqual(MAX_HISTORY_WINDOW);
    }

    expect(result.current.canLoadNewer).toBe(true);
    const olderTail = result.current.windowedActivity.at(-1)!.id;
    act(() => result.current.loadNewer());
    expect(result.current.windowedActivity).toHaveLength(MAX_HISTORY_WINDOW);
    expect(result.current.windowedActivity.at(-1)!.id).not.toBe(olderTail);
  });

  it("jumps a browsed range directly back to the bounded latest window", () => {
    const activity = transcript(1000, 1);
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));
    for (let i = 0; i < 8; i += 1) act(() => result.current.loadEarlier());
    expect(result.current.canLoadNewer).toBe(true);

    act(() => result.current.jumpToLatest());

    expect(result.current.canLoadNewer).toBe(false);
    expect(result.current.windowedActivity.at(-1)!.id).toBe("m-999-0");
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(MAX_HISTORY_WINDOW);
  });

  it("advances its replacement generation for history navigation, not live appends", () => {
    const activity = transcript(1000, 1);
    const { result, rerender } = renderHook(({ rows }) => useHistoryWindow("s1", rows, false), {
      initialProps: { rows: activity },
    });
    const initialGeneration = result.current.generation;

    act(() => result.current.loadEarlier());
    expect(result.current.generation).toBe(initialGeneration + 1);

    const afterNavigation = result.current.generation;
    const liveActivity = activity.concat([{ id: "live", kind: "message" as const, text: "live" }]);
    rerender({ rows: liveActivity });
    expect(result.current.generation).toBe(afterNavigation);

    act(() => result.current.jumpToLatest());
    expect(result.current.generation).toBe(afterNavigation + 1);

    const afterTailJump = result.current.generation;
    rerender({
      rows: transcript(10, 1)
        .map((row) => ({ ...row, id: `older-${row.id}` }))
        .concat(liveActivity),
    });
    expect(result.current.generation).toBe(afterTailJump + 1);
  });

  it("loadEarlier crosses a tool-heavy turn instead of leaving the boundary unchanged", () => {
    const activity: ActivityRow[] = [{ id: "old-user", kind: "user_prompt", text: "old prompt" }];
    for (let i = 0; i < 400; i += 1) {
      activity.push({ id: `old-tool-${i}`, kind: "tool_complete", text: `tool ${i}` });
    }
    activity.push({ id: "new-user", kind: "user_prompt", text: "new prompt" });
    for (let i = 0; i < 100; i += 1) {
      activity.push({ id: `new-message-${i}`, kind: "message", text: `message ${i}` });
    }
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));
    expect(result.current.windowedActivity[0]!.id).toBe("new-user");

    act(() => result.current.loadEarlier());

    expect(result.current.windowedActivity[0]!.id).toBe("old-user");
  });

  it("keeps earlier rows on screen when new turns append (no re-fold)", () => {
    // Regression for #2236 symptom A: an end-anchored window slid its
    // start forward on every appended row, folding visible older rows
    // back behind "Load earlier".
    const activity = transcript(100, 1); // 200 rows
    const { result, rerender } = renderHook(({ a }) => useHistoryWindow("s1", a, false), {
      initialProps: { a: activity },
    });
    const topBefore = result.current.windowedActivity[0]!.id;
    expect(topBefore).toBeDefined();
    // Stream 5 more turns (10 rows) onto the tail.
    const appended = activity.concat(
      Array.from({ length: 5 }, (_, t) => [
        { id: `nu-${t}`, kind: "user_prompt" as const, text: `new ${t}` },
        { id: `nm-${t}`, kind: "message" as const, text: `reply ${t}` },
      ]).flat(),
    );
    rerender({ a: appended });
    const ids = result.current.windowedActivity.map((r) => r.id);
    // The row the user could see is still rendered, and the new turns
    // landed too.
    expect(ids).toContain(topBefore);
    expect(ids).toContain("nu-4");
  });

  it("never snaps a long last turn forward when the next prompt lands (#3707)", () => {
    // One assistant turn longer than the default window. Before, the window
    // opened mid-turn (no boundary at or after the cap cut) and the next
    // prompt became the nearest boundary the start snapped forward to,
    // dropping every rendered part of the long turn at once. Now the window
    // opens on the whole last turn, and the start may still only move earlier.
    const long: ActivityRow[] = [{ id: "u-0", kind: "user_prompt", text: "big question" }];
    for (let r = 0; r < DEFAULT_HISTORY_WINDOW + 10; r += 1) {
      long.push({ id: `m-0-${r}`, kind: "message", text: `part ${r}` });
    }
    const { result, rerender } = renderHook(({ a }) => useHistoryWindow("s1", a, false), {
      initialProps: { a: long },
    });
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    expect(result.current.windowedActivity).toHaveLength(long.length);
    expect(result.current.canLoadEarlier).toBe(false);

    const next = long.concat([
      { id: "u-1", kind: "user_prompt", text: "follow-up" },
      { id: "m-1-0", kind: "message", text: "short answer" },
    ]);
    rerender({ a: next });
    // A regression to the flat default window would snap the start to u-1 here.
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    expect(result.current.windowedActivity.at(-1)!.id).toBe("m-1-0");
    expect(result.current.canLoadEarlier).toBe(false);
  });

  it("holds a mid-turn cut when a prompt lands after a no-boundary open (pinnedWindowStart)", () => {
    // The loaded tail holds no user row (the prompt is older than the page), so
    // the window opens on the flat default and the cap cut lands mid-turn. A
    // later prompt must not become a boundary the start snaps forward to: the
    // pinned row stays the top and the start may only move earlier. This is
    // the path the pinnedWindowStart clamp still guards after #3996.
    const noBoundary: ActivityRow[] = [];
    for (let r = 0; r < DEFAULT_HISTORY_WINDOW + 100; r += 1) {
      noBoundary.push({ id: `m-${r}`, kind: "message", text: `part ${r}` });
    }
    const { result, rerender } = renderHook(({ a }) => useHistoryWindow("s1", a, false), {
      initialProps: { a: noBoundary },
    });
    const topBefore = result.current.windowedActivity[0]!.id;
    expect(topBefore).toBe(`m-100`);
    expect(result.current.canLoadEarlier).toBe(true);
    rerender({
      a: noBoundary.concat([
        { id: "u-1", kind: "user_prompt", text: "follow-up" },
        { id: "m-1-0", kind: "message", text: "short answer" },
      ]),
    });
    expect(result.current.windowedActivity[0]!.id).toBe(topBefore);
    expect(result.current.windowedActivity.at(-1)!.id).toBe("m-1-0");
  });

  it("drops the pin when its row is trimmed away", () => {
    const activity = transcript(100, 1);
    const { result, rerender } = renderHook(({ a }) => useHistoryWindow("s1", a, false), {
      initialProps: { a: activity },
    });
    const topBefore = result.current.windowedActivity[0]!.id;
    // A retention trim removes the head of the transcript, pin included.
    const trimmed = activity.filter((r) => r.id !== topBefore).slice(60);
    rerender({ a: trimmed });
    expect(result.current.windowedActivity[0]!.id).toBe(trimmed[0]!.id);
  });

  it("re-anchors initial catch-up at the tail, then preserves live appends", () => {
    const cached = transcript(100, 1);
    const { result, rerender } = renderHook(
      ({ activity, opened }: { activity: ActivityRow[]; opened: boolean }) =>
        useHistoryWindow("s1", activity, false, opened),
      { initialProps: { activity: cached, opened: false } },
    );
    const cachedTop = result.current.windowedActivity[0]!.id;
    const rememberedDepth = result.current.windowedActivity.length;
    const missed = Array.from({ length: 50 }, (_, t) => [
      { id: `cu-${t}`, kind: "user_prompt" as const, text: `catch-up ${t}` },
      { id: `cm-${t}`, kind: "message" as const, text: `caught up ${t}` },
    ]).flat();

    rerender({ activity: cached.concat(missed), opened: false });

    expect(result.current.windowedActivity).toHaveLength(rememberedDepth);
    expect(result.current.windowedActivity.map((row) => row.id)).not.toContain(cachedTop);
    expect(result.current.windowedActivity.at(-1)!.id).toBe("cm-49");

    const freshTop = result.current.windowedActivity[0]!.id;
    const live = [
      { id: "live-user", kind: "user_prompt" as const, text: "live" },
      { id: "live-message", kind: "message" as const, text: "reply" },
    ];
    rerender({ activity: cached.concat(missed, live), opened: true });

    expect(result.current.windowedActivity.map((row) => row.id)).toContain(freshTop);
    expect(result.current.windowedActivity.at(-1)!.id).toBe("live-message");
  });

  it("uses the recent window for an unseen session and restores an expanded session", () => {
    const activity = transcript(100, 1);
    const { result, rerender } = renderHook(({ id }) => useHistoryWindow(id, activity, false), {
      initialProps: { id: "s1" },
    });
    act(() => result.current.loadEarlier());
    act(() => result.current.loadEarlier());
    const grown = result.current.windowedActivity.length;
    rerender({ id: "s2" });
    expect(result.current.windowedActivity.length).toBeLessThan(grown);
    expect(result.current.canLoadEarlier).toBe(true);
    rerender({ id: "s1" });
    expect(result.current.windowedActivity.length).toBe(grown);
  });

  it("restores an expanded window after the keyed view remounts", () => {
    const activity = transcript(100, 1);
    const first = renderHook(() => useHistoryWindow("s1", activity, false));
    act(() => first.result.current.loadEarlier());
    const grown = first.result.current.windowedActivity.length;
    first.unmount();

    const reopened = renderHook(() => useHistoryWindow("s1", activity, false));
    expect(reopened.result.current.windowedActivity.length).toBe(grown);
  });

  it("does not remember automatic live growth across remounts", () => {
    const activity = transcript(100, 1);
    const first = renderHook(({ a }) => useHistoryWindow("s1", a, false), {
      initialProps: { a: activity },
    });
    act(() => first.result.current.loadEarlier());
    const intentionallyRevealed = first.result.current.windowedActivity.length;
    const appended = activity.concat(transcript(25, 1));

    first.rerender({ a: appended });
    expect(first.result.current.windowedActivity.length).toBeGreaterThan(intentionallyRevealed);
    first.unmount();

    const reopened = renderHook(() => useHistoryWindow("s1", appended, false));
    expect(reopened.result.current.windowedActivity.length).toBe(intentionallyRevealed);
  });

  it("opens on the whole last turn when that turn is longer than the default window", () => {
    // A short backlog, then one prompt followed by a tool-heavy reply longer
    // than the default window. Before, the window opened mid-reply and the
    // prompt sat behind several "Load earlier" clicks.
    const activity = transcript(5, 1); // 10 rows
    activity.push({ id: "u-last", kind: "user_prompt", text: "the last prompt" });
    for (let r = 0; r < DEFAULT_HISTORY_WINDOW + 200; r += 1) {
      activity.push({ id: `t-${r}`, kind: "tool_complete", text: `tool ${r}` });
    }
    const { result } = renderHook(() => useHistoryWindow("s1", activity, false));
    const ids = result.current.windowedActivity.map((r) => r.id);
    expect(ids[0]).toBe("u-last");
    expect(ids).toHaveLength(DEFAULT_HISTORY_WINDOW + 201);
    // The backlog before that prompt is still behind "Load earlier".
    expect(result.current.canLoadEarlier).toBe(true);
  });

  it("re-sizes to the new session's last turn on a session switch", () => {
    const short = transcript(100, 1); // last turn is 2 rows: default window
    const { result, rerender } = renderHook(({ sid, a }) => useHistoryWindow(sid, a, false), {
      initialProps: { sid: "s1", a: short },
    });
    expect(result.current.windowedActivity.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW);
    const long: ActivityRow[] = [{ id: "u-0", kind: "user_prompt", text: "big question" }];
    for (let r = 0; r < DEFAULT_HISTORY_WINDOW + 50; r += 1) {
      long.push({ id: `m-0-${r}`, kind: "message", text: `part ${r}` });
    }
    rerender({ sid: "s2", a: long });
    expect(result.current.windowedActivity[0]!.id).toBe("u-0");
    expect(result.current.windowedActivity).toHaveLength(long.length);
    expect(result.current.canLoadEarlier).toBe(false);
  });
});
