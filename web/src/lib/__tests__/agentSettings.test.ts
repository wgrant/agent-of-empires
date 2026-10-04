import { describe, expect, it } from "vitest";
import {
  applicationText,
  pendingAgentSettings,
  reconcileLaunchIntent,
  type AgentSettingsSnapshot,
} from "../agentSettings";

const snapshot: AgentSettingsSnapshot = {
  agent: "opencode",
  running: true,
  starting: false,
  mode_id: null,
  config_options: [],
  selectors: [{ config_id: "model", category: "model", value: "new" }],
  yolo_mode: { enabled: true, applied_known: true, applied_enabled: false },
  auto_compaction: { tokens: 200000, bounds: [100000, 1000000], applied_known: true, applied_tokens: null },
};

describe("pending settings", () => {
  it("uses backend policy and lifecycle rather than one global restart flag", () => {
    for (const [running, starting, expected] of [
      [true, false, ["confirmation", "restart", "restart"]],
      [false, false, ["next_start", "next_start", "next_start"]],
      [false, true, ["applying", "applying", "applying"]],
    ] as const) {
      expect(
        pendingAgentSettings({ ...snapshot, running, starting }, [], null).map((setting) => setting.application),
      ).toEqual(expected);
    }
    const claude = pendingAgentSettings({ ...snapshot, agent: "claude" }, [], null);
    expect(claude.some((setting) => setting.id === "yolo_mode")).toBe(false);
  });

  it("requires confirmation and preserves the actual rejection reason", () => {
    const active = [{ id: "model", name: "Model", category: "model", current_value: "new", options: [] }];
    expect(pendingAgentSettings(snapshot, active, null).map((setting) => setting.id)).toEqual([
      "auto_compaction",
      "yolo_mode",
    ]);
    const rejected = pendingAgentSettings(snapshot, [], null, {
      configId: "model",
      value: "new",
      reason: "Agent is busy",
    });
    expect(rejected[0]).toMatchObject({ application: "rejected", reason: "Agent is busy" });
    expect(applicationText(rejected[0].application)).toBe("Couldn’t apply");
  });

  it("does not turn unknown unchanged defaults into restart incidents", () => {
    const defaults = {
      ...snapshot,
      selectors: [{ config_id: "effort", category: "thought_level", value: null }],
      yolo_mode: { enabled: false, applied_known: false, applied_enabled: null },
      auto_compaction: { ...snapshot.auto_compaction, tokens: null, applied_known: false },
    };
    expect(pendingAgentSettings(defaults, [], null)).toEqual([]);
    expect(pendingAgentSettings({ ...defaults, mode_id: "plan" }, [], "default")).toEqual([
      { id: "legacy_mode", name: "Mode", application: "confirmation", reason: undefined },
    ]);
  });

  it("retains explicit default and approvals-on changes until the agent confirms them", () => {
    const unknown = {
      ...snapshot,
      selectors: [],
      yolo_mode: { enabled: false, applied_known: false, applied_enabled: null },
      auto_compaction: { ...snapshot.auto_compaction, tokens: null, applied_known: false },
    };
    const intent = { auto_compaction: { tokens: null }, yolo_mode: false };
    expect(reconcileLaunchIntent(unknown, intent)).toEqual(intent);
    expect(pendingAgentSettings(unknown, [], null, null, null, intent).map((setting) => setting.id)).toEqual([
      "auto_compaction",
      "yolo_mode",
    ]);
    expect(
      reconcileLaunchIntent(
        {
          ...unknown,
          yolo_mode: { ...unknown.yolo_mode, applied_known: true, applied_enabled: false },
          auto_compaction: { ...unknown.auto_compaction, applied_known: true, applied_tokens: null },
        },
        intent,
      ),
    ).toEqual({});
    expect(reconcileLaunchIntent(snapshot, intent)).toEqual({});
  });
});
