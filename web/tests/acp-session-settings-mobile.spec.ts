// On mobile the composer collapses when focus leaves it. iOS never focuses a tapped
// button, so a tap inside the settings dialog blurs to the body; the dialog must
// survive that instead of vanishing with the collapsed footer.

import { test, expect } from "./helpers/mockedTest";
import { configOptionsUpdated, mockAcpSession, openSessionSettings, openStructuredSession } from "./helpers/acpMock";

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
  await page.waitForTimeout(100);

  const dialog = page.getByTestId("session-settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("session-mode").click();
  await dialog.getByRole("menuitem", { name: /Plan Mode/ }).click();
  await expect.poll(() => mock.configOptionBodies.length).toBe(1);
  await expect(dialog).toBeVisible();

  await page.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
});
