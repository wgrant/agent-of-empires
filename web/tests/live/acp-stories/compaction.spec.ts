// A compaction renders as one card: its outcome and measurements, with the kept summary folded away.

import { test, expect } from "../../helpers/liveTest";
import { chunk, endTurn, openStructuredView, script, startAcpSession } from "../../helpers/acp";

test("a compaction folds into one card with its summary behind a toggle", async ({ page, spawnServe }) => {
  const update = (status: string, extra: Record<string, unknown> = {}) => ({
    sessionUpdate: "compaction_update",
    compactionId: "c1",
    status,
    ...extra,
  });
  const { serve, sessionId } = await startAcpSession(spawnServe, {
    title: "story-compaction",
    fakeAcpScript: script(
      endTurn(
        update("in_progress"),
        update("completed", { summary: [{ type: "text", text: "KEPT_SUMMARY" }] }),
        // claude-agent-acp repeats the completion to add its measurements.
        update("completed", {
          _meta: {
            contextCompaction: {
              version: 1,
              trigger: "automatic",
              preTokens: 966795,
              postTokens: 10147,
              durationMs: 72000,
            },
          },
        }),
        chunk("AFTER_COMPACTION"),
      ),
    ),
  });
  await openStructuredView(page, serve, sessionId, "keep going");

  await expect(page.getByText("AFTER_COMPACTION")).toBeVisible({ timeout: 15_000 });
  const card = page.getByRole("button", { name: /compaction.*Context compacted/ });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("967k → 10k tokens");
  await expect(card).toContainText("auto · 1m 12s");
  await expect(page.getByText("KEPT_SUMMARY")).toHaveCount(0);
  await card.click();
  await expect(page.getByTestId("compaction-body").getByText("KEPT_SUMMARY")).toBeVisible();
});
