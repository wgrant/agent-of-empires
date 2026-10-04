import type { ConfigOptionDescriptor } from "./acpTypes";

export interface AgentSettingsSnapshot {
  agent: string;
  running: boolean;
  starting: boolean;
  selectors: { config_id: string; category: string; value: string | null }[];
  config_options: ConfigOptionDescriptor[];
  mode_id: string | null;
  pending: PendingSetting[];
  yolo_mode: { enabled: boolean; requires_restart: boolean; applied_known: boolean; applied_enabled: boolean | null };
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

export type SettingApplication = "applying" | "queued" | "confirmation" | "next_start" | "restart" | "rejected";

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
    case "queued":
      return "Applies when this turn finishes";
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
