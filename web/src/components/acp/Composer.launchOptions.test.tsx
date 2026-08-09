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
          sessionUsage={null}
          availableCommands={[]}
          connected
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
  it("keeps Build/Plan separate from Yolo and confirms the targeted restart", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return Promise.resolve(new Response(null, { status: 202 }));
      return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);

    fireEvent.click(screen.getByTitle("Agent mode and launch options: Build"));
    expect(screen.getByRole("menuitemradio", { name: /Build/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Launch options · restart required/)).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Yolo/ }));

    expect(screen.getByRole("dialog").textContent).toContain("Enable Yolo and restart agent?");
    fireEvent.click(screen.getByTestId("launch-option-confirm"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/sess%20open%2Fcode/acp/launch-options",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ yolo_mode: true }) }),
      ),
    );
  });
});
