// Thinking display is display-only: the transcript keeps every thought, and the
// per-session choice in the settings dialog hides or expands them retroactively.

import { test, expect } from "./helpers/mockedTest";
import {
  agentMessageChunk,
  agentThoughtChunk,
  mockAcpSession,
  openSessionSettings,
  openStructuredSession,
  stopped,
} from "./helpers/acpMock";

test("a session's thinking display hides and expands earlier thinking", async ({ page }) => {
  const mock = await mockAcpSession(page, {
    title: "thinking-display",
    initialEvents: [agentThoughtChunk("Weighing the two options."), agentMessageChunk("Picked the first."), stopped()],
  });
  await openStructuredSession(page, mock);

  const trace = page.getByText("Thinking trace");
  const thought = page.getByText("Weighing the two options.");
  await expect(trace).toBeVisible({ timeout: 15_000 });
  await expect(thought).toBeHidden();

  const choose = async (value: string) => {
    await openSessionSettings(page);
    await page.getByTestId(`thinking-display-value-${value}`).click();
    await page.getByRole("button", { name: "Done" }).click();
  };

  await choose("hidden");
  await expect(trace).toHaveCount(0);
  await expect(page.getByText("Picked the first.")).toBeVisible();

  await choose("expanded");
  await expect(thought).toBeVisible();

  // Back to the dashboard default (collapsed).
  await choose("default");
  await expect(trace).toBeVisible();
  await expect(thought).toBeHidden();
});
