import { test, expect } from "./helpers/mockedTest";
import {
  agentMessageChunk,
  configOptionsUpdated,
  mockAcpSession,
  openSessionSettings,
  openStructuredSession,
  stopped,
  usageUpdated,
  waitForComposerConnected,
} from "./helpers/acpMock";

test("mobile context settings apply without restarting and retain a stable pending indicator", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const mock = await mockAcpSession(page, {
    initialEvents: [agentMessageChunk("Ready."), usageUpdated({ used: 71000, size: 258000, cost: null }), stopped()],
  });
  let tokens: number | null = null;
  const patches: unknown[] = [];
  await page.route(`**/api/sessions/${mock.sessionId}/acp/launch-options`, async (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      if (patch.auto_compaction) tokens = patch.auto_compaction.tokens;
      await route.fulfill({ json: { status: "saved_for_next_start" } });
    } else
      await route.fulfill({
        json: {
          agent: "claude",
          running: true,
          starting: false,
          selectors: [],
          config_options: [],
          mode_id: null,
          yolo_mode: { enabled: false, requires_restart: false, applied_known: true, applied_enabled: false },
          pending: tokens === null ? [] : [{ id: "auto_compaction", name: "Auto-compaction", application: "restart" }],
          auto_compaction: {
            tokens,
            bounds: [100000, 1000000],
            applied_known: true,
            applied_tokens: null,
            running: true,
          },
        },
      });
  });
  await openStructuredSession(page, mock);
  await waitForComposerConnected(page);
  await openSessionSettings(page);
  const context = page.getByRole("region", { name: "Context management" });
  await expect(context.getByRole("button")).toHaveCount(1);
  await page.getByTestId("auto-compaction").click();
  await page.getByTestId("auto-compaction-value-custom").click();
  const input = page.getByLabel("Working context budget (tokens)");
  await input.fill("200000");
  await expect(page.getByTestId("session-settings-dialog").getByRole("status")).toContainText(
    "Applies now where possible",
  );
  for (const control of [
    input,
    page.getByRole("button", { name: "Apply", exact: true }),
    page.getByRole("button", { name: "Apply & restart" }),
  ]) {
    expect(await control.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
  }
  for (const width of [360, 412]) {
    await page.setViewportSize({ width, height: 915 });
    const inputBox = await input.boundingBox();
    const pickerBox = await page.getByTestId("auto-compaction").boundingBox();
    expect(inputBox).not.toBeNull();
    expect(pickerBox).not.toBeNull();
    expect(Math.abs(inputBox!.y + inputBox!.height / 2 - pickerBox!.y - pickerBox!.height / 2)).toBeLessThan(1);
    expect(inputBox!.x + inputBox!.width).toBeLessThan(pickerBox!.x);
    expect(pickerBox!.x + pickerBox!.width).toBeLessThan(width);
    expect(await context.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
  await page.screenshot({ path: "test-results/compaction-budget-mobile-custom.png" });
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => patches).toEqual([{ auto_compaction: { tokens: 200000 }, restart: false }]);
  await expect(page.getByTestId("session-settings-dialog")).toHaveCount(0);
  await openSessionSettings(page);
  await expect(page.getByRole("region", { name: "Pending settings" })).toContainText(
    "Auto-compaction: Restart required",
  );
  await page.screenshot({ path: "test-results/compaction-budget-mobile-pending.png" });
  expect(patches).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Apply & restart" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 1200, height: 915 });
  await expect(page.getByTestId("composer-footer").getByTestId("composer-compaction-budget")).toBeVisible();
  await expect(page.getByTestId("composer-footer").getByTestId("composer-usage")).toContainText("71k/258k");
  await page.screenshot({ path: "test-results/compaction-budget-desktop-composer.png" });
  await page.setViewportSize({ width: 360, height: 915 });
  const budget = page.getByTestId("composer-mobile-status").getByTestId("composer-compaction-budget");
  await expect(budget).toHaveText("compact 200k");
  await expect(budget).toHaveAttribute("aria-label", /Saved; restart required/);
  await expect(budget.getByTestId("composer-compaction-pending")).toBeVisible();
  expect(await budget.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
  await expect(page.getByTestId("composer-mobile-status")).toBeVisible();
  expect(
    await page.getByTestId("composer-mobile-status").evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "test-results/compaction-budget-mobile-composer.png" });
  const viewport = page.getByTestId("acp-viewport");
  const heightBefore = await viewport.evaluate((node) => node.clientHeight);
  await expect(page.getByTestId("composer-footer")).toBeHidden();
  await budget.click();
  await expect(page.getByTestId("session-settings-dialog")).toBeVisible();
  await expect(page.getByTestId("composer-footer")).toBeHidden();
  expect(await viewport.evaluate((node) => node.clientHeight)).toBe(heightBefore);
  await expect(page.getByLabel("Message the agent")).not.toBeFocused();
  await page.getByTestId("auto-compaction").click();
  await page.getByTestId("auto-compaction-value-default").click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => patches).toHaveLength(2);
  expect(patches[1]).toEqual({ auto_compaction: { tokens: null }, restart: false });
  await expect(page.getByTestId("session-settings-dialog")).toHaveCount(0);
  await expect(page.getByTestId("composer-compaction-budget")).toHaveCount(0);
  expect(await viewport.evaluate((node) => node.clientHeight)).toBe(heightBefore);
});

test("a custom budget leaves room for the mobile permission summary, queue and stop", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const mock = await mockAcpSession(page, {
    queuedPrompts: [{ id: "queued-review", text: "Follow up" }],
    initialEvents: [
      configOptionsUpdated([
        {
          id: "model",
          name: "Model",
          category: "model",
          current_value: "opus",
          options: [{ value: "opus", name: "Opus 5.5" }],
        },
      ]),
      agentMessageChunk("Ready."),
      usageUpdated({
        used: 71000,
        size: 1000000,
        cost: null,
        quota: {
          windows: [
            {
              id: "five_hour",
              duration_mins: 300,
              used_percent: 92,
              resets_at: new Date(Date.now() + 3600000).toISOString(),
            },
            {
              id: "seven_day",
              duration_mins: 10080,
              used_percent: 37,
              resets_at: new Date(Date.now() + 86400000).toISOString(),
            },
          ],
          limited: false,
          observed_at: new Date().toISOString(),
        },
      }),
      stopped(),
    ],
  });
  await page.route(`**/api/sessions/${mock.sessionId}/acp/launch-options`, (route) =>
    route.fulfill({
      json: {
        agent: "claude",
        running: true,
        starting: false,
        selectors: [],
        config_options: [],
        mode_id: null,
        yolo_mode: { enabled: false, requires_restart: true, applied_known: true, applied_enabled: false },
        pending: [{ id: "auto_compaction", name: "Auto-compaction", application: "restart" }],
        auto_compaction: { tokens: 1000000, bounds: [100000, 1000000], applied_known: true, applied_tokens: null },
      },
    }),
  );
  await openStructuredSession(page, mock);
  const strip = page.getByTestId("composer-mobile-status");
  await expect(strip.getByTestId("composer-compaction-budget")).toBeVisible();
  mock.pushEvents(["AgentTurnStarted"]);
  const stop = strip.getByRole("button", { name: "Stop", exact: true });
  await expect(stop).toBeVisible();
  await expect(strip.getByTestId("composer-mobile-queued-count")).toHaveText("Q1");
  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 915 });
    const summary = strip.getByTestId("composer-mobile-summary");
    await expect(summary).toContainText("Default");
    expect((await summary.boundingBox())!.width).toBeGreaterThanOrEqual(40);
    expect(await strip.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect((await stop.boundingBox())!.x + (await stop.boundingBox())!.width).toBeLessThanOrEqual(width);
    await expect(strip.getByTestId("composer-quota-window").nth(1)).toBeHidden();
    await page.screenshot({ path: `test-results/compaction-budget-busy-${width}.png` });
  }
  const usage = strip.getByTestId("composer-usage");
  await usage.click();
  await usage.hover();
  await expect(page.getByRole("tooltip")).toContainText("7d: 37% used");
  await strip.getByTestId("composer-compaction-budget").click();
  await expect(page.getByTestId("session-settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Apply & restart" }).click();
  await expect(page.getByRole("heading", { name: "Restart the agent?" })).toBeVisible();
  await expect(page.getByTestId("auto-compaction")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeFocused();
  await page.screenshot({ path: "test-results/settings-restart-active-turn.png" });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByTestId("auto-compaction")).toBeVisible();
});
