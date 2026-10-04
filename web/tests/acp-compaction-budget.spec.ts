import { test, expect } from "./helpers/mockedTest";
import {
  agentMessageChunk,
  mockAcpSession,
  openSessionSettings,
  openStructuredSession,
  stopped,
  waitForComposerConnected,
} from "./helpers/acpMock";

test("mobile context settings save without restart and require confirmation to apply", async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const mock = await mockAcpSession(page, { initialEvents: [agentMessageChunk("Ready."), stopped()] });
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
          yolo_mode: { enabled: false, applied_known: true, applied_enabled: false },
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
  await expect(page.getByTestId("session-settings-dialog").getByRole("status")).toHaveText("Unsaved changes.");
  for (const control of [
    input,
    page.getByRole("button", { name: "Save changes" }),
    page.getByRole("button", { name: "Save and restart…" }),
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
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => patches).toEqual([{ auto_compaction: { tokens: 200000 }, restart: false }]);
  await expect(page.getByRole("region", { name: "Pending settings" })).toContainText(
    "Auto-compaction: Restart required",
  );
  await page.screenshot({ path: "test-results/compaction-budget-mobile-pending.png" });
  await page.getByRole("button", { name: "Restart agent…" }).click();
  await expect(page.getByText(/Restarting interrupts/)).toBeVisible();
  expect(patches).toHaveLength(1);
  await page.screenshot({ path: "test-results/compaction-budget-mobile-confirm.png" });
  await page.getByRole("button", { name: "Cancel restart" }).click();
  await page.getByTestId("auto-compaction").click();
  await page.getByTestId("auto-compaction-value-default").click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => patches).toHaveLength(2);
  expect(patches[1]).toEqual({ auto_compaction: { tokens: null }, restart: false });
  await expect(context.getByRole("button")).toHaveCount(1);
});
