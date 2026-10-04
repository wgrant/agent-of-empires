// On mobile the composer collapses when focus leaves it. iOS never focuses a tapped
// button, so a tap inside the settings dialog blurs to the body; the dialog must
// survive that instead of vanishing with the collapsed footer.

import { test, expect } from "./helpers/mockedTest";
import { configOptionsUpdated, mockAcpSession, openSessionSettings, openStructuredSession } from "./helpers/acpMock";

test("the first model remains selectable below the settings title", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  const mock = await mockAcpSession(page, {
    title: "settings-mobile-model-clipping",
    initialEvents: [
      configOptionsUpdated([
        {
          id: "model",
          name: "Model",
          category: "model",
          current_value: "sonnet",
          options: [
            { value: "opus", name: "Opus 5.5", description: "For your toughest challenges" },
            { value: "sonnet", name: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
            { value: "haiku", name: "Haiku 4.5", description: "Fastest for quick answers" },
            { value: "older", name: "Sonnet 5" },
          ],
        },
      ]),
    ],
  });
  await openStructuredSession(page, mock);
  await page
    .getByTestId("composer-mobile-status")
    .getByRole("button", { name: /Open message composer/ })
    .click();
  await openSessionSettings(page);
  await page.getByTestId("config-option-model").click();
  const body = page.locator("#session-settings-dialog-desc");
  const menu = page.getByRole("menu");
  const bounds = await body.boundingBox();
  const menuBounds = await menu.boundingBox();
  expect(menuBounds!.y).toBeGreaterThanOrEqual(bounds!.y);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  await page.getByRole("menuitem", { name: /Opus 5.5/ }).click();
  await expect(page.getByTestId("config-option-model")).toContainText("Opus 5.5");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => mock.configOptionBodies.some((body) => body.value === "opus")).toBe(true);
});

test("the mobile settings dialog survives focus leaving the composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  const mock = await mockAcpSession(page, {
    title: "settings-mobile-blur",
    initialEvents: [
      configOptionsUpdated([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          current_value: "default",
          options: [
            { value: "default", name: "Default" },
            { value: "plan", name: "Plan Mode" },
          ],
        },
      ]),
    ],
    onConfigOption: (body) => [
      configOptionsUpdated([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          current_value: body.value,
          options: [
            { value: "default", name: "Default" },
            { value: "plan", name: "Plan Mode" },
          ],
        },
      ]),
    ],
  });
  await openStructuredSession(page, mock);
  await page
    .getByTestId("composer-mobile-status")
    .getByRole("button", { name: /Open message composer/ })
    .click();
  await openSessionSettings(page);

  // What an iOS tap on a button does to focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const dialog = page.getByTestId("session-settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("session-mode").click();
  await dialog.getByRole("menuitem", { name: /Plan Mode/ }).click();
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => mock.configOptionBodies.length).toBe(1);
  await expect(dialog).toHaveCount(0);
});
