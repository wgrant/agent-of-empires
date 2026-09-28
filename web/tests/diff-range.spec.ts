// A plugin pane row with a diff target points this browser's diff pane at a
// commit range: no worker call and no saved base, a header naming the range,
// the row marked while it shows, and a way back to the working tree.

import { test, expect } from "./helpers/mockedTest";
import { mockTerminalApis } from "./helpers/terminal-mocks";
import { diffFilesResponse } from "./helpers/diffMocks";

const SESSION = "pinch-test";
const PANE = "plugin:acme.stack:stack";

test.use({ viewport: { width: 1280, height: 720 } });

test("a pane row opens its commit range in the diff pane, and Working tree returns", async ({ page }) => {
  await mockTerminalApis(page);
  await page.route("**/api/plugins/ui-state", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            plugin_id: "acme.stack",
            slot: "pane",
            id: "stack",
            session_id: SESSION,
            payload: {
              title: "Stack",
              default_location: "bottom",
              blocks: [
                { kind: "row", label: "layer", diff: { base: "main", head: "layer" }, method: "stack.never" },
                { kind: "row", label: "top", diff: { base: "layer", head: "top" }, selected: true },
              ],
            },
          },
        ],
        notifications: [],
      },
    }),
  );
  const workerCalls: string[] = [];
  await page.route("**/api/plugins/acme.stack/action", async (route) => {
    workerCalls.push(route.request().postData() ?? "");
    await route.fulfill({ status: 202, json: { ok: true } });
  });
  const baseWrites: string[] = [];
  await page.route("**/api/sessions/*/diff-base", async (route) => {
    baseWrites.push(route.request().method());
    await route.fulfill({ json: {} });
  });
  const viewsAsked: (string | null)[] = [];
  await page.unroute("**/api/sessions/*/diff/files");
  await page.route("**/api/sessions/*/diff/files*", (route) => {
    const views = new URL(route.request().url()).searchParams.get("views");
    viewsAsked.push(views);
    const [view] = views ? (JSON.parse(views) as { base: string; head?: string }[]) : [];
    if (!view?.head) {
      return route.fulfill({ json: diffFilesResponse([{ path: "src/live.ts" }]) });
    }
    return route.fulfill({
      json: diffFilesResponse(
        [{ path: `src/${view.head}.ts` }],
        [{ base_branch: view.base, head: view.head } as { base_branch: string }],
      ),
    });
  });

  await page.goto(`/session/${SESSION}`);
  await page.getByTestId(`pane-toggle-${PANE}`).click();
  const layer = page.getByRole("button", { name: "layer", exact: true });
  const top = page.getByRole("button", { name: "top", exact: true });
  // The plugin's own `selected` is advisory: nothing is shown yet.
  await expect(top).toHaveAttribute("aria-pressed", "false");

  await layer.click();
  await expect(page.getByTestId("pane-tab-diff")).toBeVisible();
  await expect(page.getByTestId("diff-view-badge")).toContainText("main...layer");
  await expect(page.getByText("layer.ts")).toBeVisible();
  await expect(layer).toHaveAttribute("aria-pressed", "true");
  await expect(top).toHaveAttribute("aria-pressed", "false");
  expect(viewsAsked).toContain(JSON.stringify([{ base: "main", head: "layer" }]));

  await top.click();
  await expect(page.getByTestId("diff-view-badge")).toContainText("layer...top");
  await expect(page.getByText("top.ts")).toBeVisible();
  await expect(top).toHaveAttribute("aria-pressed", "true");
  await expect(layer).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("diff-view-reset").click();
  await expect(page.getByTestId("diff-view-badge")).toHaveCount(0);
  await expect(page.getByText("live.ts")).toBeVisible();
  await expect(top).toHaveAttribute("aria-pressed", "false");

  expect(workerCalls).toEqual([]);
  expect(baseWrites).toEqual([]);
});
