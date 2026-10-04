// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSettings } from "../../hooks/useAgentSettings";
import { useState } from "react";
import type { AgentSettingsSnapshot } from "../../lib/agentSettings";

import type { ConfigOptionDescriptor } from "../../lib/acpTypes";
import { consumePendingSwitchAgent } from "../../lib/switchAgentTrigger";
import { sessionThinkingDisplayKey } from "../../lib/thinkingDisplay";
import { AgentProfileProvider } from "../../lib/agentProfileContext";
import { SessionSettingsControl } from "./SessionSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

let settings: AgentSettingsSnapshot;
let requests: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  settings = {
    agent: "claude",
    running: true,
    starting: false,
    mode_id: null,
    selectors: [],
    config_options: [],
    yolo_mode: { enabled: false, applied_known: true, applied_enabled: false },
    auto_compaction: { tokens: null, bounds: [100000, 1000000], applied_known: true, applied_tokens: null },
  };
  requests = [];
  fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      requests.push(patch);
      if (patch.auto_compaction) settings.auto_compaction.tokens = patch.auto_compaction.tokens;
      if (patch.yolo_mode !== undefined) settings.yolo_mode.enabled = patch.yolo_mode;
      if (patch.config_options)
        settings.selectors = patch.config_options.map((option: { config_id: string; value: string }) => ({
          ...option,
          category: option.config_id === "mode" ? "mode" : "model",
        }));
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify(settings), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

const MODE: ConfigOptionDescriptor = {
  id: "mode",
  name: "Mode",
  category: "mode",
  current_value: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "bypassPermissions", name: "Bypass Permissions" },
  ],
};
const MODEL: ConfigOptionDescriptor = {
  id: "model",
  name: "Model",
  category: "model",
  current_value: "opus",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet" },
  ],
};

function mount(configOptions: ConfigOptionDescriptor[], turnActive = false) {
  function Harness() {
    const controller = useAgentSettings("s1", true);
    const [open, setOpen] = useState(false);
    return (
      <AgentProfileProvider toolKey="claude">
        <SessionSettingsControl
          sessionId="s1"
          currentAgent="claude"
          yoloMode={false}
          availableModes={[]}
          currentModeId={null}
          legacyMode="default"
          configOptions={configOptions}
          pendingConfigOption={null}
          summary={{ agent: "Claude", permission: "Default", model: "Opus", effort: null }}
          settings={controller}
          open={open}
          onOpenChange={setOpen}
          turnActive={turnActive}
        />
      </AgentProfileProvider>
    );
  }
  render(<Harness />);
}

const trigger = () => screen.getByTestId("session-settings-trigger");
const dialog = () => screen.queryByTestId("session-settings-dialog");

describe("SessionSettingsControl", () => {
  it("shows the summary and tints only the permission for a destructive mode", () => {
    mount([{ ...MODE, current_value: "bypassPermissions" }, MODEL]);
    expect(trigger().textContent).toContain("Claude · Default · Opus");
    expect(screen.getByTestId("session-summary-permission").className).toContain("text-rose-300");
    expect(trigger().className).not.toContain("rose");
    expect(screen.getByTestId("session-summary-model").className).not.toContain("rose");
    expect(dialog()).toBeNull();
  });

  it("drafts the mode, applies explicitly, closes and reports pending confirmation", async () => {
    mount([MODE, MODEL]);
    fireEvent.click(trigger());
    const mode = screen.getByTestId("session-mode");
    expect(mode.getAttribute("aria-label")).toMatch(/Default/);
    fireEvent.click(mode);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Bypass Permissions/ }));
    expect(requests).toHaveLength(0);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Apply", exact: true }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply", exact: true }));
    await waitFor(() =>
      expect(requests).toEqual([
        { config_options: [{ config_id: "mode", value: "bypassPermissions" }], restart: false },
      ]),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByTestId("session-settings-pending")).toBeTruthy();
    expect(trigger().getAttribute("aria-label")).toContain("Mode: Pending confirmation");
  });

  it("lets Escape close an open model menu before the dialog", () => {
    mount([MODE, MODEL]);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("config-option-model"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(dialog()).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeNull();
  });

  it("drafts thinking display, cancels without applying and saves without an agent request", async () => {
    mount([MODEL]);
    fireEvent.click(trigger());
    const picker = () => screen.getByTestId("thinking-display");
    const choose = (value: string) => {
      fireEvent.click(picker());
      fireEvent.click(screen.getByTestId(`thinking-display-value-${value}`));
    };
    expect(picker().textContent).toBe("Default (Collapsed)");

    choose("hidden");
    expect(picker().textContent).toBe("Hidden");
    expect(localStorage.getItem(sessionThinkingDisplayKey("s1"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()).toBeNull();
    fireEvent.click(trigger());
    expect(picker().textContent).toBe("Default (Collapsed)");
    choose("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Apply", exact: true }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(localStorage.getItem(sessionThinkingDisplayKey("s1"))).toBe("hidden");
    expect(requests).toHaveLength(0);

    fireEvent.click(trigger());
    choose("default");
    expect(picker().textContent).toBe("Default (Collapsed)");
    fireEvent.click(screen.getByRole("button", { name: "Apply", exact: true }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(localStorage.getItem(sessionThinkingDisplayKey("s1"))).toBeNull();
  });

  it("hands off to the switch-agent flow from the agent row", () => {
    mount([MODEL]);
    fireEvent.click(trigger());
    expect(screen.getByTestId("session-settings-agent").textContent).toBe("Claude");
    fireEvent.click(screen.getByRole("button", { name: "Switch agent…" }));
    expect(dialog()).toBeNull();
    expect(consumePendingSwitchAgent("s1")).toBe(true);
  });

  it("closes clean settings from Close", () => {
    mount([MODEL]);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(dialog()).toBeNull();
  });

  it.each(["Cancel", "Escape", "backdrop"])("discards only this visit's edits on %s", async (action) => {
    settings.auto_compaction.tokens = 200000;
    mount([MODEL]);
    fireEvent.click(trigger());
    await screen.findByTestId("auto-compaction");
    fireEvent.click(screen.getByTestId("config-option-model"));
    fireEvent.click(screen.getByTestId("config-option-model-value-sonnet"));
    if (action === "Cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else if (action === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(screen.getByTestId("session-settings-dialog"));
    expect(dialog()).toBeNull();
    expect(requests).toHaveLength(0);
    expect(screen.getByTestId("session-settings-pending")).toBeTruthy();
    fireEvent.click(trigger());
    expect(screen.getByTestId("config-option-model").textContent).toContain("Opus");
    expect(screen.getByLabelText("Working context budget (tokens)")).toHaveProperty("value", "200000");
    expect(screen.queryByRole("button", { name: "Apply", exact: true })).toBeNull();
  });

  it("saves a dormant model and budget together and keeps pending visible after closing", async () => {
    settings.running = false;
    settings.auto_compaction.applied_known = false;
    mount([MODEL]);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByTestId("auto-compaction"));
    fireEvent.click(screen.getByTestId("auto-compaction-value-custom"));
    fireEvent.change(screen.getByLabelText("Working context budget (tokens)"), { target: { value: "200000" } });
    fireEvent.click(screen.getByTestId("config-option-model"));
    fireEvent.click(screen.getByTestId("config-option-model-value-sonnet"));
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Apply", exact: true }));
    await waitFor(() =>
      expect(requests).toEqual([
        {
          config_options: [{ config_id: "model", value: "sonnet" }],
          auto_compaction: { tokens: 200000 },
          restart: false,
        },
      ]),
    );
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByTestId("session-settings-pending")).toBeTruthy();
    fireEvent.click(trigger());
    expect(screen.getByTestId("config-option-model").textContent).toContain("Sonnet");
    expect(screen.getByText("2 settings pending")).toBeTruthy();
  });

  it("cancels unsaved edits directly and preserves rejected-apply drafts", async () => {
    mount([MODEL]);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByTestId("auto-compaction"));
    fireEvent.click(screen.getByTestId("auto-compaction-value-custom"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(requests).toHaveLength(0);
    fireEvent.click(trigger());
    expect(screen.queryByLabelText("Working context budget (tokens)")).toBeNull();
    fireEvent.click(screen.getByTestId("auto-compaction"));
    fireEvent.click(screen.getByTestId("auto-compaction-value-custom"));
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ message: "Save rejected" }), { status: 403 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply", exact: true }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Save rejected");
    expect(screen.getByRole("status").textContent).toContain("otherwise on next agent start");
    expect((screen.getByLabelText("Working context budget (tokens)") as HTMLInputElement).value).toBe("100000");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()).toBeNull();
  });

  it("requires confirmation before restarting and batches the budget with the restart", async () => {
    mount([MODEL], true);
    fireEvent.click(trigger());
    fireEvent.click(await screen.findByTestId("auto-compaction"));
    fireEvent.click(screen.getByTestId("auto-compaction-value-custom"));
    fireEvent.click(screen.getByRole("button", { name: "Apply & restart" }));
    expect(screen.getByText(/This interrupts the current turn/)).toBeTruthy();
    expect(screen.queryByTestId("auto-compaction")).toBeNull();
    expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("auto-compaction")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply & restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply & restart" }));
    await waitFor(() => expect(requests).toEqual([{ auto_compaction: { tokens: 100000 }, restart: true }]));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("restarts an idle agent directly and offers no restart when reverting to the applied budget", async () => {
    settings.auto_compaction.tokens = 200000;
    mount([MODEL]);
    fireEvent.click(trigger());
    await screen.findByTestId("auto-compaction");
    fireEvent.click(screen.getByRole("button", { name: "Apply & restart" }));
    await waitFor(() => expect(requests).toEqual([{ restart: true }]));
    await waitFor(() => expect(dialog()).toBeNull());
    fireEvent.click(trigger());
    fireEvent.click(screen.getByTestId("auto-compaction"));
    fireEvent.click(screen.getByTestId("auto-compaction-value-default"));
    expect(screen.queryByRole("button", { name: "Apply & restart" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("session-settings-pending")).toBeTruthy();
  });
});
