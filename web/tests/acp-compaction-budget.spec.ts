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
      tokens = patch.auto_compaction.tokens;
      await route.fulfill({ json: { status: "saved_for_next_start" } });
    } else
      await route.fulfill({
        json: {
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
  await expect(context.getByRole("button")).toHaveCount(0);
  await page.getByLabel("Auto-compaction", { exact: true }).selectOption("custom");
  const input = page.getByLabel("Working context budget (tokens)");
  await input.fill("200000");
  await expect(context.getByRole("status")).toHaveText("Unsaved changes.");
  for (const control of [
    context.getByRole("combobox"),
    input,
    context.getByRole("button", { name: "Save for next start" }),
    context.getByRole("button", { name: "Apply and restart…" }),
  ]) {
    expect(await control.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32);
  }
  await page.getByRole("button", { name: "Save for next start" }).click();
  await expect.poll(() => patches).toEqual([{ auto_compaction: { tokens: 200000 }, restart: false }]);
  await expect(page.getByText(/Saved. Restart the agent/)).toBeVisible();
  await page.screenshot({ path: "test-results/compaction-budget-mobile-pending.png" });
  await page.getByRole("button", { name: "Apply and restart…" }).click();
  await expect(page.getByText(/Restarting interrupts/)).toBeVisible();
  expect(patches).toHaveLength(1);
  await page.screenshot({ path: "test-results/compaction-budget-mobile-confirm.png" });
  await page.getByRole("button", { name: "Cancel restart" }).click();
  await page.getByLabel("Auto-compaction", { exact: true }).selectOption("default");
  await page.getByRole("button", { name: "Save for next start" }).click();
  await expect.poll(() => patches).toHaveLength(2);
  expect(patches[1]).toEqual({ auto_compaction: { tokens: null }, restart: false });
  await expect(context.getByRole("button")).toHaveCount(0);
});
