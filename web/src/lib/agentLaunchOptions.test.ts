import { afterEach, describe, expect, it, vi } from "vitest";

import { agentLaunchOptions, updateAgentLaunchOptions } from "./agentLaunchOptions";

afterEach(() => vi.unstubAllGlobals());

describe("agent launch options", () => {
  it("offers OpenCode Yolo separately from ACP modes and sends a typed restart patch", async () => {
    expect(agentLaunchOptions("claude", false)).toEqual([]);
    expect(agentLaunchOptions("opencode", true)).toMatchObject([{ id: "yolo_mode", enabled: true }]);

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await updateAgentLaunchOptions("session / one", { yolo_mode: true });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session%20%2F%20one/acp/launch-options", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yolo_mode: true }),
    });
  });

  it("surfaces the server's launch-option error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Agent is not restartable" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(updateAgentLaunchOptions("session", { yolo_mode: false })).rejects.toThrow("Agent is not restartable");
  });
});
