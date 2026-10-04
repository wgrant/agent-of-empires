import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSettingsPatch, AgentSettingsSnapshot } from "../lib/agentSettings";
import { updateAgentLaunchOptions } from "../lib/agentLaunchOptions";

export function useAgentSettings(sessionId: string, refreshWhileOpen: boolean) {
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    snapshot: AgentSettingsSnapshot;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const saving = useRef<string | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (saving.current === sessionId) return;
      const sequence = ++requestSequence.current;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`);
        if (!response.ok) throw new Error(`Could not load agent settings (HTTP ${response.status})`);
        const snapshot = (await response.json()) as AgentSettingsSnapshot;
        if (
          !snapshot.auto_compaction ||
          !Array.isArray(snapshot.selectors) ||
          !snapshot.yolo_mode ||
          !Array.isArray(snapshot.pending)
        ) {
          throw new Error("Could not read agent settings");
        }
        if (!cancelled && sequence === requestSequence.current) {
          setLoaded({ sessionId, snapshot });
          setError(null);
        }
      } catch (e) {
        if (!cancelled && sequence === requestSequence.current)
          setError(e instanceof Error ? e.message : "Could not load agent settings");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), refreshWhileOpen ? 2000 : 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, refreshWhileOpen, revision]);
  const save = async (patch: AgentSettingsPatch) => {
    const sequence = ++requestSequence.current;
    saving.current = sessionId;
    try {
      await updateAgentLaunchOptions(sessionId, patch);
      // Keep the draft visible until the saved values have been read back.
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`);
      if (!response.ok) {
        refresh();
        throw new Error("Settings were saved, but could not be reloaded. Reopen settings to check their status.");
      }
      const snapshot = (await response.json()) as AgentSettingsSnapshot;
      if (
        !snapshot.auto_compaction ||
        !Array.isArray(snapshot.selectors) ||
        !snapshot.yolo_mode ||
        !Array.isArray(snapshot.pending)
      ) {
        throw new Error("Settings were saved, but could not be read back. Reopen settings to check their status.");
      }
      if (sequence === requestSequence.current) {
        setLoaded({ sessionId, snapshot });
        setError(null);
      }
    } finally {
      if (saving.current === sessionId) saving.current = null;
      refresh();
    }
  };
  return {
    snapshot: loaded?.sessionId === sessionId ? loaded.snapshot : null,
    error,
    save,
  };
}
