import type { ReactNode } from "react";
import type { DisplayStatus } from "../../lib/session";

export type CommandActionGroup = "Actions" | "Sessions" | "Conversations" | "Settings";

export interface CommandAction {
  id: string;
  title: string;
  subtitle?: string;
  group: CommandActionGroup;
  keywords?: string[];
  shortcut?: string;
  icon?: ReactNode;
  status?: DisplayStatus;
  statusCreatedAt?: string | null;
  perform: () => void;
}
