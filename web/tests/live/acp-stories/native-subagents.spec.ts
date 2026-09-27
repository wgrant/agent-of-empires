// Native subagent sessions (ACP RFD #1992): a child's own transcript renders inside its card.

import { test, expect } from "../../helpers/liveTest";
import { HOLD, chunk, endTurn, openStructuredView, releaseTurn, script, startAcpSession } from "../../helpers/acp";

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

test("a woken teammate stays one agent whose own view holds every run", async ({ page, spawnServe }) => {
  const kid = "tester-session";
  const woken = `${kid}:generation:2`;
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "story-agent-view",
    fakeAcpScript: script(
      endTurn(
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: kid,
          name: "tester",
          task: "Wait for bugs",
          capabilities: {},
        },
        { ...chunk("FIRST_RUN"), onSession: kid },
        { sessionUpdate: "subagent_state_update", subagentSessionId: kid, state: "completed" },
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: woken,
          name: "Wait for bugs",
          task: '<agent-message from="reviewer">\nADD_BUG\n</agent-message>',
          capabilities: {},
        },
        { ...chunk("SECOND_RUN"), onSession: woken },
        { sessionUpdate: "subagent_state_update", subagentSessionId: woken, state: "completed" },
        chunk("LEAD_REPLY"),
      ),
    ),
  });
  await openStructuredView(page, serve, sessionId, "team up");
  await expect(page.getByText("LEAD_REPLY")).toBeVisible({ timeout: 15_000 });
  // One card for both runs.
  await expect(page.getByRole("button", { name: /subagent.*tester/ })).toHaveCount(1);

  const switcher = page.getByTestId("agent-switcher");
  // Woken once, it waits for messages between runs.
  await expect(switcher.getByRole("tab", { name: /tester.*idle/ })).toBeVisible();
  await switcher.getByRole("tab", { name: /tester/ }).click();
  await expect(page.getByText("LEAD_REPLY")).toHaveCount(0);
  const messages = page.getByTestId("agent-message");
  await expect(messages.first()).toContainText("Wait for bugs");
  await expect(messages.nth(1)).toContainText("From reviewer");
  await expect(messages.nth(1)).toContainText("ADD_BUG");
  await expect(page.getByText("FIRST_RUN")).toBeVisible();
  await expect(page.getByText("SECOND_RUN")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message the agent" })).toHaveAttribute(
    "placeholder",
    /Viewing tester\. Switch to Lead to send/,
  );

  await page.keyboard.press("Escape");
  await expect(page.getByText("LEAD_REPLY")).toBeVisible();
  await expect(switcher.getByRole("tab", { name: "Lead" })).toHaveAttribute("aria-selected", "true");
});

test("the composer counts background work until it finishes", async ({ page, spawnServe }) => {
  const kid = "worker-session";
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "story-background-chip",
    fakeAcpScript: script(
      endTurn(
        {
          sessionUpdate: "subagent_spawned",
          subagentSessionId: kid,
          name: "Explorer",
          task: "Read it",
          capabilities: {},
        },
        HOLD,
        { sessionUpdate: "subagent_state_update", subagentSessionId: kid, state: "completed" },
        chunk("ALL_DONE"),
      ),
    ),
  });
  await openStructuredView(page, serve, sessionId, "delegate");

  const chip = page.getByTestId("composer-background-work").filter({ visible: true });
  await expect(chip).toHaveText("1 in background", { timeout: 15_000 });
  await expect(chip).toHaveAttribute("title", /^Explorer · active \d+s ago$/);
  await chip.click();
  await expect(page.getByTestId("background-item").filter({ hasText: "Explorer" })).toBeVisible();

  releaseTurn(serve);
  await expect(page.getByText("ALL_DONE")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("composer-background-work")).toHaveCount(0);
});
