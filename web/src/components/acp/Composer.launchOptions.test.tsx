// @vitest-environment jsdom

import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentProfileProvider } from "../../lib/agentProfileContext";
import type { ConfigOptionDescriptor } from "../../lib/acpTypes";
import { Composer } from "./Composer";

const MODE: ConfigOptionDescriptor = {
  id: "mode",
  name: "Session Mode",
  category: "mode",
  current_value: "build",
  options: [
    { value: "build", name: "Build" },
    { value: "plan", name: "Plan" },
  ],
};

function Harness() {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: [],
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentProfileProvider toolKey="opencode">
        <Composer
          sessionId="sess open/code"
          currentAgent="opencode"
          yoloMode={false}
          availableModes={[]}
          currentModeId={null}
          legacyMode="Default"
          configOptions={[MODE]}
          pendingConfigOption={null}
          setConfigOption={() => {}}
          sessionUsage={{ used: 71000, size: 258000, cost: null }}
          availableCommands={[]}
          availability={{ kind: "send_now" }}
          turnActive={false}
          enqueuePrompt={() => {}}
          promptCapabilities={null}
          pendingAttachments={[]}
          setPendingAttachments={() => {}}
          queuedPrompts={[]}
          editQueuedPrompt={() => {}}
        />
      </AgentProfileProvider>
    </AssistantRuntimeProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("OpenCode launch options", () => {
  it.each([
    { name: "default", tokens: null, applied: null, running: true, status: null },
    { name: "applied custom", tokens: 200000, applied: 200000, running: true, status: null },
    { name: "pending restart", tokens: 200000, applied: null, running: true, status: "restart required" },
    { name: "pending start", tokens: 200000, applied: null, running: false, status: "applies when the agent starts" },
  ])(
    "shows the $name compaction budget beside usage and opens settings",
    async ({ tokens, applied, running, status }) => {
      const snapshot = {
        agent: "opencode",
        running,
        starting: false,
        selectors: [],
        config_options: [],
        mode_id: null,
        yolo_mode: { enabled: false, applied_known: true, applied_enabled: false },
        auto_compaction: { tokens, bounds: [100000, 1000000], applied_known: true, applied_tokens: applied },
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(snapshot))),
      );
      render(<Harness />);
      await waitFor(() =>
        expect(screen.getByTestId("session-settings-trigger").getAttribute("aria-label")).toContain(
          status ? "settings pending" : "Session settings:",
        ),
      );
      if (tokens === null) {
        fireEvent.click(screen.getByTestId("session-settings-trigger"));
        await screen.findByTestId("auto-compaction");
        expect(screen.queryAllByTestId("composer-compaction-budget")).toHaveLength(0);
        return;
      }
      const indicators = await screen.findAllByTestId("composer-compaction-budget");
      expect(indicators).toHaveLength(2);
      for (const indicator of indicators) {
        expect(indicator.textContent).toBe("compact 200k");
        expect(indicator.getAttribute("aria-label")).toContain("Auto-compaction budget: 200,000 tokens");
        if (status) expect(indicator.getAttribute("aria-label")).toContain(status);
        else expect(indicator.getAttribute("aria-label")).not.toContain("Saved;");
      }
      expect(screen.queryAllByTestId("composer-compaction-pending")).toHaveLength(status ? 2 : 0);
      for (const usage of screen.getAllByTestId("composer-usage")) {
        expect(usage.textContent).toContain("71k/258k");
      }
      fireEvent.click(indicators[0]!);
      expect(screen.getByTestId("session-settings-dialog")).toBeTruthy();
      expect(screen.getByLabelText("Working context budget (tokens)")).toHaveProperty("value", "200000");
    },
  );

  it("keeps Build/Plan separate from Yolo and confirms the targeted restart", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(new Response(null, { status: 202 }));
      if (url.endsWith("launch-options"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              agent: "opencode",
              running: true,
              starting: false,
              selectors: [],
              config_options: [],
              mode_id: null,
              yolo_mode: { enabled: false, applied_known: true, applied_enabled: false },
              auto_compaction: { tokens: null, bounds: null, applied_known: true, applied_tokens: null },
            }),
            { status: 200 },
          ),
        );
      return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByTestId("session-settings-trigger"));
    expect(screen.getByTestId("session-mode").getAttribute("aria-label")).toMatch(/Build/);
    await screen.findByText(/Changes require a restart/);
    fireEvent.click(screen.getByRole("switch", { name: /Yolo/ }));
    expect(screen.getByTestId("session-settings-dialog")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save and restart…" }));
    expect(screen.getByText(/Restarting interrupts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart agent" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/sess%20open%2Fcode/acp/launch-options",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ yolo_mode: true, restart: true }) }),
      ),
    );
  });
});
