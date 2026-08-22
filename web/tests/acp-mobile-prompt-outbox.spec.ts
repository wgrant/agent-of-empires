import { devices } from "@playwright/test";

import { expect, test } from "./helpers/mockedTest";
import { agentMessageChunk, mockAcpSession, openStructuredSession } from "./helpers/acpMock";

test.use({ ...devices["iPhone 13"] });

test("mobile prompt delivery expands from its compact aggregate", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "mobile-prompt-outbox",
    initialEvents: [agentMessageChunk("Agent output")],
    queuedPrompts: [{ id: "queued-1", text: "Follow up after this turn" }],
  });
  await openStructuredSession(page, mock);

  const panel = page.getByTestId("prompt-outbox-panel");
  const toggle = page.getByTestId("prompt-outbox-toggle");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("1 queued", { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByText("Follow up after this turn", { exact: true })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel.getByText("Follow up after this turn", { exact: true })).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByText("Follow up after this turn", { exact: true })).toHaveCount(0);
});
