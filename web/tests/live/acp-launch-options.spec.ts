// Restart-backed ACP launch options.
//
// OpenCode's Build/Plan choice is a live ACP config option, but its permission
// policy is read from OPENCODE_PERMISSION when the adapter starts. This test
// proves the persisted session patch replaces only that worker, resumes the
// existing ACP session, and applies both sides of the environment toggle.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test as base } from "@playwright/test";

import { waitForAcpReady } from "../helpers/acp";
import { listSessions, seedSessionViaAoeAdd, spawnAoeServe } from "../helpers/aoeServe";

function fakeLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

base("OpenCode Yolo patch persists and restarts with the new launch environment", async ({}, testInfo) => {
  const serve = await spawnAoeServe({
    authMode: "none",
    acp: true,
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    seedFn: seedSessionViaAoeAdd({ title: "opencode-launch-options", tool: "opencode" }),
  });

  try {
    const sessionId = String((await listSessions(serve.baseUrl))[0]!.id);
    const logPath = join(serve.home, "fake-acp.log");
    const enable = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/acp/enable`, { method: "POST" });
    expect(enable.ok).toBeTruthy();
    await waitForAcpReady(serve.baseUrl, sessionId, 30_000, serve.home);
    expect(fakeLog(logPath)).toContain("launchEnv opencodePermission=false");

    const enableYolo = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/acp/launch-options`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yolo_mode: true }),
    });
    expect(enableYolo.status).toBe(202);
    await expect
      .poll(() => fakeLog(logPath), { timeout: 15_000, intervals: [100, 200, 500] })
      .toContain("launchEnv opencodePermission=true");
    await expect.poll(async () => (await listSessions(serve.baseUrl))[0]!.yolo_mode, { timeout: 10_000 }).toBe(true);

    const falseBefore = fakeLog(logPath).split("launchEnv opencodePermission=false").length - 1;
    const disableYolo = await fetch(`${serve.baseUrl}/api/sessions/${sessionId}/acp/launch-options`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yolo_mode: false }),
    });
    expect(disableYolo.status).toBe(202);
    await expect
      .poll(() => fakeLog(logPath).split("launchEnv opencodePermission=false").length - 1, {
        timeout: 15_000,
        intervals: [100, 200, 500],
      })
      .toBeGreaterThan(falseBefore);
    await expect.poll(async () => (await listSessions(serve.baseUrl))[0]!.yolo_mode, { timeout: 10_000 }).toBe(false);

    // Both replacements should load the stored ACP session rather than create
    // a fresh conversation. The initial launch is the only session/new.
    const log = fakeLog(logPath);
    expect(log.split("handleRequest method=session/new").length - 1).toBe(1);
    expect(log.split("handleRequest method=session/load").length - 1).toBeGreaterThanOrEqual(2);
  } finally {
    await serve.stop();
  }
});
