// Claude Code hook runs, shown as the CLI shows them: a silent success never.

import type { HookInfo } from "./acpTypes";

/** One line for the hook, or null for one that succeeded silently. Mirrors the Rust `HookInfo::headline`. */
export function hookHeadline(hook: HookInfo, output: string): string | null {
  const first = output.split("\n").find((line) => line.trim() !== "");
  let outcome: string;
  if (hook.status === "running") return `Running ${hook.name} hook`;
  if (hook.status === "success") {
    if (first === undefined) return null;
    outcome = `${hook.name} hook`;
  } else if (hook.status === "cancelled") {
    outcome = `${hook.name} hook cancelled`;
  } else {
    outcome = hook.exit_code != null ? `${hook.name} hook failed (exit ${hook.exit_code})` : `${hook.name} hook failed`;
  }
  return first === undefined ? outcome : `${outcome}: ${first.trim()}`;
}
