import { describe, expect, it } from "vitest";

import type { ConfigOptionDescriptor } from "../../lib/acpTypes";
import { compactComposerStatusText, composerStatusParts, composerStatusText } from "./composerStatus";

const configOptions: ConfigOptionDescriptor[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    current_value: "gpt-5.6-terra",
    options: [{ value: "gpt-5.6-terra", name: "GPT-5.6 Terra" }],
  },
  {
    id: "effort",
    name: "Reasoning Effort",
    category: "thought_level",
    current_value: "medium",
    options: [{ value: "medium", name: "Medium" }],
  },
];

describe("composerStatusParts", () => {
  // Yolo on a mode that already grants everything collapses to "Yolo"; a mode it adds to stays.
  it.each([
    ["codex", "Agent (full access)", true, "Codex · Yolo · GPT-5.6 Terra · Medium"],
    ["claude", "Bypass permissions", true, "Claude · Yolo · GPT-5.6 Terra · Medium"],
    ["opencode", "build", true, "OpenCode · build · Yolo · GPT-5.6 Terra · Medium"],
    ["claude", "Plan", false, "Claude · Plan · GPT-5.6 Terra · Medium"],
    ["claude", undefined, false, "Claude · GPT-5.6 Terra · Medium"],
  ])("summarizes %s in %s (yolo %s)", (agent, mode, yoloMode, text) => {
    expect(composerStatusText(composerStatusParts({ agent, mode, yoloMode, configOptions }))).toBe(text);
  });

  it("drops the agent and the model's qualifier in the compact summary", () => {
    const parts = { agent: "Claude", permission: "Auto", model: "Opus 5.5 (1M context)", effort: "High" };
    expect(compactComposerStatusText(parts)).toBe("Auto · Opus 5.5 · High");
    expect(compactComposerStatusText({ ...parts, model: "(custom)", permission: null })).toBe("(custom) · High");
  });

  it("keeps the permission separate so it can be tinted alone", () => {
    expect(composerStatusParts({ agent: "claude", mode: "Plan", yoloMode: false, configOptions: [] })).toEqual({
      agent: "Claude",
      permission: "Plan",
      model: null,
      effort: null,
    });
  });
});
