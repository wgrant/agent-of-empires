// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigOptionDescriptor } from "../../lib/acpTypes";
import { consumePendingSwitchAgent } from "../../lib/switchAgentTrigger";
import { sessionThinkingDisplayKey } from "../../lib/thinkingDisplay";
import { AgentProfileProvider } from "../../lib/agentProfileContext";
import { SessionSettingsControl } from "./SessionSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
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

function mount(configOptions: ConfigOptionDescriptor[], setConfigOption = vi.fn()) {
  render(
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
        setConfigOption={setConfigOption}
        summary={{ agent: "Claude", permission: "Default", model: "Opus", effort: null }}
      />
    </AgentProfileProvider>,
  );
  return { setConfigOption };
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

  it("changes the mode in place and keeps the dialog open", () => {
    const { setConfigOption } = mount([MODE, MODEL]);
    fireEvent.click(trigger());
    const mode = screen.getByTestId("session-mode");
    expect(mode.getAttribute("aria-label")).toMatch(/Default/);
    fireEvent.click(mode);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /Bypass Permissions/ }));
    expect(setConfigOption).toHaveBeenCalledWith("mode", "bypassPermissions");
    expect(dialog()).not.toBeNull();
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

  it("overrides the thinking display for this session and returns it to the default", () => {
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
    expect(localStorage.getItem(sessionThinkingDisplayKey("s1"))).toBe("hidden");

    choose("default");
    expect(picker().textContent).toBe("Default (Collapsed)");
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

  it("closes from Done", () => {
    mount([MODEL]);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(dialog()).toBeNull();
  });
});
