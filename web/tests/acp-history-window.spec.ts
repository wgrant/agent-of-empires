// User story (#2144): opening a long structured-view transcript renders
// the most recent slice first, so the user lands at the latest message
// instead of waiting for the whole backlog to paint. Older turns are
// revealed by the "Load earlier messages" button, a chunk at a time.
//
// Seeds 100 turns (a UserPromptSent + an agent reply each = 200 activity
// rows, past the 150-row default window) and asserts the oldest turn is
// not painted until the user loads earlier history.

import type { Page } from "@playwright/test";

import { test, expect } from "./helpers/mockedTest";
import { mockAcpSession, openStructuredSession, agentMessageChunk, stopped } from "./helpers/acpMock";

function userPrompt(text: string) {
  return { UserPromptSent: { text } };
}

const TURNS = 100;

function longTranscript(): unknown[] {
  const events: unknown[] = [];
  for (let i = 0; i < TURNS; i += 1) {
    events.push(userPrompt(`prompt number ${i}`));
    events.push(agentMessageChunk(`reply number ${i}`));
    events.push(stopped());
  }
  return events;
}

// Click "Load earlier" until the oldest turn (`prompt number 0`) surfaces.
// The button is conditionally mounted and disables itself while a server
// `before` fetch is in flight (StructuredView `canLoadEarlierHistory` /
// `loadingEarlierHistory`), so it unmounts and remounts mid-interaction. A
// fixed-interval click loop races that re-render and the click lands on a
// detaching node ("element was detached from the DOM"), which flaked #2236's
// network-paging test. Re-resolve the button on every poll and bound each
// click, so a click waits out an in-flight load instead of racing it.
async function revealOldestTurn(page: Page): Promise<void> {
  const oldest = page.getByText("prompt number 0");
  await expect(async () => {
    if ((await oldest.count()) === 0) {
      await page
        .getByTestId("acp-load-earlier")
        .click({ timeout: 2_000 })
        .catch(() => {});
    }
    expect(await oldest.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 30_000 });
}

test("long transcript renders recent first and reveals older on Load earlier", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "story-history-window",
    initialEvents: longTranscript(),
  });
  await openStructuredSession(page, mock);

  // Recent turn is painted on open.
  await expect(page.getByText(`reply number ${TURNS - 1}`)).toBeVisible({ timeout: 10_000 });

  // The oldest turn is windowed out (200 rows, 150-row default window).
  await expect(page.getByText("prompt number 0")).toHaveCount(0);

  // The control to widen the window is offered.
  const loadEarlier = page.getByTestId("acp-load-earlier");
  await expect(loadEarlier).toBeVisible();

  // Growing the window enough times reveals the oldest turn.
  await revealOldestTurn(page);
  await expect(page.getByText("prompt number 0")).toBeVisible({ timeout: 10_000 });
});

// User story (#2236): replacing assistant-ui's bounded runtime for an
// explicit older-history reveal must retain the reader's current row. The
// runtime mounts tail-following by default, so this exercises the race by
// dispatching the button handler directly rather than asking Playwright to
// scroll the off-screen button into view first.
test("Load earlier preserves the reader position through the runtime replacement", async ({ page }) => {
  // Two navigations are required to catch a callback that accidentally keeps
  // the first runtime's publication generation.
  const events: unknown[] = [];
  for (let i = 0; i < 250; i += 1) {
    events.push(userPrompt(`anchor prompt ${i}`), agentMessageChunk(`anchor reply ${i}`), stopped());
  }
  const mock = await mockAcpSession(page, {
    title: "story-history-scroll-anchor",
    initialEvents: events,
  });
  await openStructuredSession(page, mock);

  const viewport = page.getByTestId("acp-viewport");
  await expect(page.getByText("anchor reply 249")).toBeVisible({ timeout: 10_000 });
  await viewport.evaluate((el) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
  });
  const before = await viewport.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }));

  for (let load = 0; load < 2; load += 1) {
    const beforeLoad =
      load === 0
        ? before
        : await viewport.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }));
    await page.getByTestId("acp-load-earlier").evaluate((el) => {
      if (el instanceof HTMLButtonElement) el.click();
    });

    await expect.poll(() => viewport.evaluate((el) => el.scrollHeight)).toBeGreaterThan(beforeLoad.scrollHeight);
    await expect
      .poll(async () => {
        const after = await viewport.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }));
        return after.scrollTop - (beforeLoad.scrollTop + after.scrollHeight - beforeLoad.scrollHeight);
      })
      .toBeCloseTo(0, -1);
  }
});

test("large transcript keeps the mounted history range bounded while navigating", async ({ page }) => {
  const turns = 600;
  const events: unknown[] = [];
  for (let i = 0; i < turns; i += 1) {
    events.push(userPrompt(`large prompt ${i}`));
    events.push(agentMessageChunk(`large reply ${i}`));
    events.push(stopped());
  }
  const mock = await mockAcpSession(page, { title: "story-history-bounded-range", initialEvents: events });
  await openStructuredSession(page, mock);

  await expect(page.getByText(`large reply ${turns - 1}`)).toBeVisible({ timeout: 10_000 });
  for (let i = 0; i < 6; i += 1) {
    const loadEarlier = page.getByTestId("acp-load-earlier");
    if ((await loadEarlier.count()) === 0) break;
    await loadEarlier.click();
    await page.waitForTimeout(100);
  }

  // The transcript moves toward older rows, but never mounts all of the
  // loaded history. This is intentionally a DOM-shape assertion rather than
  // a timing benchmark, so it stays deterministic on CI.
  await expect(page.getByText(/large prompt 1[0-9]{2}/).first()).toBeAttached();
  const elements = await page.getByTestId("acp-viewport").evaluate((root) => root.getElementsByTagName("*").length);
  expect(elements).toBeLessThan(5_000);
});

test("scroll to latest returns a scrolled-away reader to the loaded tail", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "story-history-scroll-latest",
    initialEvents: longTranscript(),
  });
  await openStructuredSession(page, mock);

  await expect(page.getByText(`reply number ${TURNS - 1}`)).toBeVisible({ timeout: 10_000 });
  const viewport = page.getByTestId("acp-viewport");
  await viewport.hover();
  await page.mouse.wheel(0, -400);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeGreaterThan(16);
  await expect(page.getByTestId("acp-jump-to-latest")).toBeVisible();

  await page.getByTestId("acp-jump-to-latest").click();

  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
    .toBeLessThanOrEqual(16);
  await expect(page.getByTestId("acp-jump-to-latest")).toBeHidden();
});

// User story (#2236): scrolling to the top auto-loads earlier messages,
// no button click needed.
test("scrolling to the top auto-loads earlier messages", async ({ page }) => {
  const events: unknown[] = [];
  for (let i = 0; i < 250; i += 1) {
    events.push(userPrompt(`autoload prompt ${i}`), agentMessageChunk(`autoload reply ${i}`), stopped());
  }
  const mock = await mockAcpSession(page, {
    title: "story-history-autoload",
    initialEvents: events,
  });
  await openStructuredSession(page, mock);

  await expect(page.getByText("autoload reply 249")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("autoload prompt 0")).toHaveCount(0);

  const viewport = page.getByTestId("acp-viewport");
  // A real upward arrival at the top reveals one earlier page. Repeated range
  // replacement is covered by the mixed-navigation scenario below; this
  // synthetic event sequence intentionally stays to one physical gesture.
  for (let load = 0; load < 1; load += 1) {
    await viewport.evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      el.scrollTop = 300;
      el.dispatchEvent(new Event("scroll"));
    });
    // The real control deliberately debounces arrivals at the boundary, so
    // wait beyond that guard before simulating the next independent scroll.
    await page.waitForTimeout(700);
    const beforeHeight = await viewport.evaluate((el) => el.scrollHeight);
    await viewport.evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => viewport.evaluate((el) => el.scrollHeight)).toBeGreaterThan(beforeHeight);
    // The external viewport schedules its default initialization scroll in a
    // frame; stay through it so this proves a history replacement cannot land
    // at the top briefly and then fall through to the tail.
    await page.waitForTimeout(250);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(16);
  }
});

// A real reader often alternates between dragging the scrollbar to the top
// and clicking the visible control while an earlier replacement is mounting.
// Keep the reader at the requested top boundary through that mixed path: a
// stale replacement anchor used to let assistant-ui's tail-follow win and
// strand a range between the two navigators.
test("mixed top-scroll and button navigation does not jump away from requested history", async ({ page }) => {
  const events: unknown[] = [];
  for (let i = 0; i < 1_000; i += 1) {
    events.push(userPrompt(`mixed prompt ${i}`), agentMessageChunk(`mixed reply ${i}`), stopped());
  }
  const mock = await mockAcpSession(page, { title: "story-history-mixed-navigation", initialEvents: events });
  await openStructuredSession(page, mock);

  const viewport = page.getByTestId("acp-viewport");
  await expect(page.getByText("mixed reply 999")).toBeVisible({ timeout: 10_000 });

  for (let step = 0; step < 4; step += 1) {
    // Re-arm the top-edge auto-loader, then arrive at the boundary.
    await viewport.evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      el.scrollTop = Math.min(300, Math.max(1, el.scrollHeight - el.clientHeight));
      el.dispatchEvent(new Event("scroll"));
    });
    await page.waitForTimeout(700);
    await viewport.evaluate((el) => {
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });

    // Interleave an explicit click in the same boundary arrival. The control
    // may be temporarily disabled while a server page fetches, so resolve it
    // at the instant of the click and tolerate that intentional no-op.
    await page.getByTestId("acp-load-earlier").evaluate((el) => {
      if (el instanceof HTMLButtonElement && !el.disabled) el.click();
    });
    await page.waitForTimeout(500);

    // Both actions requested older history from the top. The settled range
    // must still show that newly revealed boundary rather than falling to the
    // current tail because a stale runtime mount scrolled it there.
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(16);
  }
});

// User story (#2236, feature C): a transcript larger than one replay page
// loads recent-first and fetches still-older events from the server when
// the already-loaded rows are exhausted (network paging, not just the
// in-reducer window).
test("loads older events from the server when the loaded window is exhausted", async ({ page }) => {
  // 350 turns = 1050 events, past the client's 1000-event page, so the
  // tail leaves older history on the server (has_more) reachable only via
  // a `before` fetch.
  const events: unknown[] = [];
  for (let i = 0; i < 350; i += 1) {
    events.push(userPrompt(`prompt number ${i}`));
    events.push(agentMessageChunk(`reply number ${i}`));
    events.push(stopped());
  }
  const mock = await mockAcpSession(page, { title: "story-history-network", initialEvents: events });
  await openStructuredSession(page, mock);

  await expect(page.getByText("reply number 349")).toBeVisible({ timeout: 10_000 });
  // Turn 0 is not in the recent page at all; it must be fetched.
  await expect(page.getByText("prompt number 0")).toHaveCount(0);

  // Reveal loaded rows, then trip the server `before` fetch, until the very
  // first turn surfaces.
  await revealOldestTurn(page);
  await expect(page.getByText("prompt number 0")).toBeVisible({ timeout: 10_000 });
});

// User story (#2236, symptom A): a new turn must not fold earlier rows
// already in the window back behind "Load earlier".
test("a new turn does not re-fold earlier messages", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "story-history-nofold",
    initialEvents: longTranscript(),
  });
  await openStructuredSession(page, mock);

  await expect(page.getByText(`reply number ${TURNS - 1}`)).toBeVisible({ timeout: 10_000 });
  // 200 rows, 150-row window snapped to a user boundary: turn 25 is the
  // oldest turn in the window and is rendered (off-screen but in the DOM).
  await expect(page.getByText("prompt number 25")).toHaveCount(1);

  // The agent streams several new turns.
  for (let i = 0; i < 20; i += 1) {
    mock.pushEvents([userPrompt(`fresh prompt ${i}`), agentMessageChunk(`fresh reply ${i}`), stopped()]);
  }
  await expect(page.getByText("fresh reply 19")).toBeVisible({ timeout: 10_000 });

  // Pre-fix the window would have slid forward ~40 rows and dropped turn
  // 25; with the anchor-on-append fix it stays rendered.
  await expect(page.getByText("prompt number 25")).toHaveCount(1);
});

// User story (#2144): when /clear is active and the windowed-out rows are
// all before the clear divider, "Load earlier" would be a no-op (those
// turns are reached via the cleared-turns banner, not this control), so
// the button must not appear.
test("Load earlier stays hidden when only pre-clear rows are windowed out", async ({ page }) => {
  const events: unknown[] = [];
  // 100 pre-clear turns (200 rows) so the window cut lands well before
  // the clear divider, then a /clear and a couple of short post-clear turns.
  for (let i = 0; i < 100; i += 1) {
    events.push(userPrompt(`old prompt ${i}`));
    events.push(agentMessageChunk(`old reply ${i}`));
    events.push(stopped());
  }
  events.push("SessionCleared");
  for (let i = 0; i < 2; i += 1) {
    events.push(userPrompt(`new prompt ${i}`));
    events.push(agentMessageChunk(`new reply ${i}`));
    events.push(stopped());
  }

  const mock = await mockAcpSession(page, { title: "story-history-window-clear", initialEvents: events });
  await openStructuredSession(page, mock);

  // Post-clear content renders; pre-clear turns are folded behind the banner.
  await expect(page.getByText("new reply 1")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("old prompt 0")).toHaveCount(0);

  // The windowed-out rows are all pre-clear, so the control is suppressed.
  await expect(page.getByTestId("acp-load-earlier")).toHaveCount(0);
});
