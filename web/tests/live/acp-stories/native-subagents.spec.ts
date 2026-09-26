// Native subagent sessions (ACP RFD #1992): a child's own transcript renders inside its card.

import { test, expect } from "../../helpers/liveTest";
import { chunk, endTurn, openStructuredView, script, startAcpSession } from "../../helpers/acp";

test("a native subagent renders as a card holding its own transcript", async ({ page, spawnServe }) => {
  const kid = "kid-session";
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "story-native-subagent",
    fakeAcpScript: script(
      endTurn(
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: kid,
          name: "Explorer",
          task: "Count the lines",
          capabilities: {},
        },
        { ...chunk("CHILD_REPLY"), onSession: kid },
        { sessionUpdate: "tool_call", toolCallId: "kid-read", title: "Read notes", kind: "read", onSession: kid },
        { sessionUpdate: "tool_call_update", toolCallId: "kid-read", status: "completed", onSession: kid },
        { sessionUpdate: "subagent_state_update", subagentSessionId: kid, state: "completed" },
        chunk("MAIN_REPLY"),
      ),
    ),
  });
  await openStructuredView(page, serve, sessionId, "delegate");

  const card = page.getByRole("button", { name: /subagent.*Explorer/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("MAIN_REPLY")).toBeVisible();
  // The child's reply lives in its card, not the main one.
  await expect(page.getByText("CHILD_REPLY")).toHaveCount(0);
  await card.click();
  const body = page.getByTestId("native-subagent-body");
  await expect(body.getByText("CHILD_REPLY")).toBeVisible();
  await expect(body.getByText("Count the lines")).toBeVisible();
  await expect(body.getByText("Read notes")).toBeVisible();

  // The Background pane lists it and jumps back to its card, reopening it.
  await card.click();
  await expect(body).toHaveCount(0);
  await page.getByRole("button", { name: /Toggle background pane/ }).click();
  await expect(page.getByTestId("background-item").filter({ hasText: "Explorer" })).toBeVisible();
  await page.getByRole("button", { name: "Show in transcript" }).click();
  await expect(body.getByText("CHILD_REPLY")).toBeVisible();
});
