import { test, expect } from "./helpers/mockedTest";
import { mockAcpSession, openStructuredSession, stopped } from "./helpers/acpMock";

test("collapsed compactions show their cause and token counts on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const mock = await mockAcpSession(page);
  const rows = ["manual", "automatic", "idle"].map((trigger, index) => ({
    id: `compacted-${index}`,
    group_id: `g${index}`,
    kind: "compacted",
    at: new Date().toISOString(),
    text: "RETAINED_SUMMARY",
    compaction: { state: "completed", trigger, pre_tokens: 211057, post_tokens: 2071, duration_ms: 9406 },
  }));
  await page.routeWebSocket("**/sessions/*/acp/ws*", (socket) => {
    socket.send(JSON.stringify({ session_id: mock.sessionId, seq: 1, event: stopped() }));
    socket.send(JSON.stringify({ kind: "transcript_snapshot", rows }));
  });
  await openStructuredSession(page, mock);
  const details = page.getByTestId("compaction-details");
  await expect(details).toHaveCount(3);
  for (const [index, cause] of ["Manual", "Automatic", "Idle · before cache expiry"].entries()) {
    await expect(details.nth(index)).toContainText(cause);
    await expect(details.nth(index)).toContainText("211k → 2.1k tokens");
    expect(await details.nth(index).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  }
  await expect(page.getByTestId("compaction-body")).toHaveCount(0);
  await page.screenshot({ path: "test-results/compaction-cards-mobile.png" });
  await page
    .getByRole("button", { name: /compaction.*Context compacted/ })
    .first()
    .click();
  await expect(page.getByTestId("compaction-body")).toContainText("RETAINED_SUMMARY");
});
