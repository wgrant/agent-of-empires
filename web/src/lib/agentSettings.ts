import type { ConfigOptionDescriptor } from "./acpTypes";

export interface AgentSettingsSnapshot {
  agent: string;
  running: boolean;
  starting: boolean;
  selectors: { config_id: string; category: string; value: string | null }[];
  config_options: ConfigOptionDescriptor[];
  mode_id: string | null;
  yolo_mode: { enabled: boolean; applied_known: boolean; applied_enabled: boolean | null };
  auto_compaction: {
    tokens: number | null;
    bounds: [number, number] | null;
    applied_known: boolean;
    applied_tokens: number | null;
  };
}

export interface AgentSettingsPatch {
  config_options?: { config_id: string; value: string }[];
  mode_id?: string;
  yolo_mode?: boolean;
  auto_compaction?: { tokens: number | null };
  restart?: boolean;
}

export type SettingApplication = "applying" | "confirmation" | "next_start" | "restart" | "rejected";

export interface LaunchSettingsIntent {
  auto_compaction?: { tokens: number | null };
  yolo_mode?: boolean;
}

/** An unknown worker cannot confirm a reset to Default or approvals-on. */
export function reconcileLaunchIntent(
  snapshot: AgentSettingsSnapshot,
  intent: LaunchSettingsIntent,
): LaunchSettingsIntent {
  const remaining: LaunchSettingsIntent = {};
  if (
    intent.auto_compaction &&
    snapshot.auto_compaction.bounds &&
    intent.auto_compaction.tokens === snapshot.auto_compaction.tokens &&
    !(
      snapshot.auto_compaction.applied_known &&
      snapshot.auto_compaction.applied_tokens === intent.auto_compaction.tokens
    )
  ) {
    remaining.auto_compaction = intent.auto_compaction;
  }
  if (
    intent.yolo_mode !== undefined &&
    snapshot.agent === "opencode" &&
    intent.yolo_mode === snapshot.yolo_mode.enabled &&
    !(snapshot.yolo_mode.applied_known && snapshot.yolo_mode.applied_enabled === intent.yolo_mode)
  ) {
    remaining.yolo_mode = intent.yolo_mode;
  }
  return remaining;
}

export interface PendingSetting {
  id: string;
  name: string;
  application: SettingApplication;
  reason?: string;
}

export function applicationText(application: SettingApplication): string {
  switch (application) {
    case "applying":
      return "Applying…";
    case "next_start":
      return "Applies when the agent starts";
    case "restart":
      return "Restart required";
    case "confirmation":
      return "Pending confirmation";
    case "rejected":
      return "Couldn’t apply";
  }
}

/** Only agent-confirmed selectors count as applied; HTTP acceptance is not confirmation. */
export function pendingAgentSettings(
  snapshot: AgentSettingsSnapshot,
  active: ConfigOptionDescriptor[],
  currentModeId: string | null,
  failure?: { configId: string; value: string; reason: string } | null,
  modeFailure?: { modeId: string; reason: string } | null,
  launchIntent: LaunchSettingsIntent = {},
): PendingSetting[] {
  const pending: PendingSetting[] = [];
  const application = snapshot.starting ? "applying" : snapshot.running ? "confirmation" : "next_start";
  for (const saved of snapshot.selectors) {
    if (saved.value === null) continue;
    const option = active.find((option) => option.id === saved.config_id);
    if (!snapshot.running || option?.current_value !== saved.value) {
      const rejected = snapshot.running && failure?.configId === saved.config_id && failure.value === saved.value;
      pending.push({
        id: saved.config_id,
        name:
          option?.name ??
          snapshot.config_options.find((option) => option.id === saved.config_id)?.name ??
          { model: "Model", mode: "Mode", thought_level: "Reasoning effort" }[saved.category] ??
          saved.category,
        application: rejected ? "rejected" : application,
        reason: rejected ? failure.reason : undefined,
      });
    }
  }
  if (
    snapshot.mode_id &&
    !snapshot.selectors.some((selector) => selector.category === "mode" && selector.value !== null) &&
    (!snapshot.running || snapshot.mode_id !== currentModeId)
  ) {
    const rejected = snapshot.running && modeFailure?.modeId === snapshot.mode_id;
    pending.push({
      id: "legacy_mode",
      name: "Mode",
      application: rejected ? "rejected" : application,
      reason: rejected ? modeFailure.reason : undefined,
    });
  }
  const launchApplication = snapshot.starting ? "applying" : snapshot.running ? "restart" : "next_start";
  const budget = snapshot.auto_compaction;
  if (
    budget.bounds &&
    (budget.applied_known
      ? budget.tokens !== budget.applied_tokens
      : budget.tokens !== null || launchIntent.auto_compaction !== undefined)
  ) {
    pending.push({ id: "auto_compaction", name: "Auto-compaction", application: launchApplication });
  }
  const yolo = snapshot.yolo_mode;
  if (
    snapshot.agent === "opencode" &&
    (yolo.applied_known ? yolo.enabled !== yolo.applied_enabled : yolo.enabled || launchIntent.yolo_mode !== undefined)
  ) {
    pending.push({ id: "yolo_mode", name: "Yolo", application: launchApplication });
  }
  return pending;
}
