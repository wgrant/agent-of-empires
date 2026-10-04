import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSettingsPatch, AgentSettingsSnapshot, LaunchSettingsIntent } from "../lib/agentSettings";
import { updateAgentLaunchOptions } from "../lib/agentLaunchOptions";
import { confirmedLaunchIntent, readLaunchIntent, storeLaunchIntent } from "../lib/agentSettingsIntent";

export function useAgentSettings(sessionId: string, refreshWhileOpen: boolean) {
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    snapshot: AgentSettingsSnapshot;
    launchIntent: LaunchSettingsIntent;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestSequence = useRef(0);
  const saving = useRef(false);
  const intentMemory = useRef<{ sessionId: string; agent: string; intent: LaunchSettingsIntent } | null>(null);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (saving.current) return;
      const sequence = ++requestSequence.current;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`);
        if (!response.ok) throw new Error(`Could not load agent settings (HTTP ${response.status})`);
        const snapshot = (await response.json()) as AgentSettingsSnapshot;
        if (!snapshot.auto_compaction || !Array.isArray(snapshot.selectors) || !snapshot.yolo_mode) {
          throw new Error("Could not read agent settings");
        }
        if (!cancelled && sequence === requestSequence.current) {
          const previous = intentMemory.current;
          const launchIntent = confirmedLaunchIntent(
            sessionId,
            snapshot,
            previous?.sessionId === sessionId && previous.agent === snapshot.agent ? previous.intent : undefined,
          );
          intentMemory.current = { sessionId, agent: snapshot.agent, intent: launchIntent };
          setLoaded({ sessionId, snapshot, launchIntent });
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
    ++requestSequence.current;
    saving.current = true;
    try {
      await updateAgentLaunchOptions(sessionId, patch);
      const agent = loaded?.snapshot.agent;
      if (agent) {
        const previous = intentMemory.current;
        const intent = {
          ...(previous?.sessionId === sessionId && previous.agent === agent
            ? previous.intent
            : readLaunchIntent(sessionId, agent)),
        };
        if (patch.auto_compaction) intent.auto_compaction = patch.auto_compaction;
        if (patch.yolo_mode !== undefined) intent.yolo_mode = patch.yolo_mode;
        storeLaunchIntent(sessionId, agent, intent);
        intentMemory.current = { sessionId, agent, intent };
      }
      // Keep the draft visible until the saved values have been read back.
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/acp/launch-options`);
      if (!response.ok) {
        refresh();
        throw new Error("Settings were saved, but could not be reloaded. Reopen settings to check their status.");
      }
      const snapshot = (await response.json()) as AgentSettingsSnapshot;
      if (!snapshot.auto_compaction || !Array.isArray(snapshot.selectors) || !snapshot.yolo_mode) {
        throw new Error("Settings were saved, but could not be read back. Reopen settings to check their status.");
      }
      const previous = intentMemory.current;
      const launchIntent = confirmedLaunchIntent(
        sessionId,
        snapshot,
        previous?.sessionId === sessionId && previous.agent === snapshot.agent ? previous.intent : undefined,
      );
      intentMemory.current = { sessionId, agent: snapshot.agent, intent: launchIntent };
      setLoaded({ sessionId, snapshot, launchIntent });
      setError(null);
    } finally {
      saving.current = false;
      refresh();
    }
  };
  return {
    snapshot: loaded?.sessionId === sessionId ? loaded.snapshot : null,
    launchIntent: loaded?.sessionId === sessionId ? loaded.launchIntent : {},
    error,
    save,
  };
}
