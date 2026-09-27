// A message's time shows on hover, or on a tap on touch devices: in the left
// margin when the transcript has one, else in the gap under the message.

import type { Page } from "@playwright/test";
import { test, expect } from "./helpers/mockedTest";
import { agentMessageChunk, mockAcpSession, openStructuredSession, stopped } from "./helpers/acpMock";

const history = [
  { UserPromptSent: { text: "when was this?", prompt_id: "p-1", synthesized: false, attachments: [] } },
  agentMessageChunk("REPLY_TEXT"),
  stopped(),
];

async function openReply(page: Page, title: string) {
  const mock = await mockAcpSession(page, { title, initialEvents: history });
  await openStructuredSession(page, mock);
  const reply = page.getByText("REPLY_TEXT");
  await expect(reply).toBeVisible({ timeout: 15_000 });
  const time = page.getByTestId("message-time").last();
  await expect(time).toHaveCSS("opacity", "0");
  await expect(time).toHaveText(/\d{1,2}:\d{2}/);
  return { reply, time };
}

for (const { width, where } of [
  { width: 2400, where: "the margin" },
  { width: 1600, where: "the gap under the message" },
]) {
  test.describe(`${width}px desktop`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: false });

    test(`hovering a reply shows its time in ${where}; clicking does not pin it`, async ({ page }) => {
      const { reply, time } = await openReply(page, `message-time-${width}`);
      await reply.hover();
      await expect(time).toHaveCSS("opacity", "1");
      const label = (await time.boundingBox())!;
      const text = (await reply.boundingBox())!;
      if (where === "the margin") expect(label.x + label.width).toBeLessThanOrEqual(text.x);
      else expect(label.y).toBeGreaterThanOrEqual(text.y + text.height);

      await reply.click();
      await page.mouse.move(0, 0);
      await expect(time).toHaveCSS("opacity", "0");
    });
  });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a tap on a message toggles its time under it", async ({ page }) => {
    const { reply, time } = await openReply(page, "message-time-phone");
    await reply.tap();
    await expect(time).toHaveCSS("opacity", "1");
    expect((await time.boundingBox())!.y).toBeGreaterThanOrEqual((await reply.boundingBox())!.y);
    await reply.tap();
    await expect(time).toHaveCSS("opacity", "0");
  });
});
