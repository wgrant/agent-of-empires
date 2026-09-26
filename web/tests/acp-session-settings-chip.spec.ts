// The footer's session summary chip: only the permission segment carries the
// warning tint, and on a narrow footer the chip truncates on the toolbar's
// line instead of wrapping onto its own.

import { test, expect } from "./helpers/mockedTest";
import { configOptionsUpdated, mockAcpSession, openStructuredSession } from "./helpers/acpMock";

test("a yolo session's chip tints only its permission and stays on the toolbar line", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const mock = await mockAcpSession(page, {
    title: "chip-yolo",
    yoloMode: true,
    initialEvents: [
      configOptionsUpdated([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          current_value: "bypassPermissions",
          options: [
            { value: "default", name: "Manual" },
            { value: "bypassPermissions", name: "Bypass permissions" },
          ],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          current_value: "opus",
          options: [{ value: "opus", name: "Opus 5.5 with 1M context" }],
        },
        {
          id: "effort",
          name: "Effort",
          category: "thought_level",
          current_value: "xhigh",
          options: [{ value: "xhigh", name: "XHigh" }],
        },
      ]),
    ],
  });
  await openStructuredSession(page, mock);
  await page
    .getByTestId("composer-mobile-status")
    .getByRole("button", { name: /Open message composer/ })
    .click();

  const chip = page.getByTestId("session-settings-trigger");
  await expect(chip).toContainText("Claude · Yolo · Opus 5.5", { timeout: 15_000 });
  await expect(chip).not.toContainText("Bypass permissions");
  await expect(chip.getByTestId("session-summary-permission")).toHaveClass(/text-rose-300/);
  await expect(chip).not.toHaveClass(/rose/);

  const attach = page.getByRole("button", { name: /Attach files|does not accept attachments|agent capabilities/ });
  const [chipBox, attachBox] = [(await chip.boundingBox())!, (await attach.boundingBox())!];
  expect(Math.abs(chipBox.y + chipBox.height / 2 - (attachBox.y + attachBox.height / 2))).toBeLessThan(4);
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(360);
});
