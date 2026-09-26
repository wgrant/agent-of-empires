import { useWebSettings } from "../../hooks/useWebSettings";
import { parseThinkingDisplay, THINKING_DISPLAY_LABELS, THINKING_DISPLAYS } from "../../lib/thinkingDisplay";
import { FontSizeControl } from "./FontSizeControl";
import { SelectField } from "./FormFields";

/** Structured view display preferences, stored in `aoe-web-settings` (already clamped). */
export function StructuredViewDisplaySettings() {
  const { settings, update } = useWebSettings();

  return (
    <div className="space-y-4">
      <h3 className="font-mono text-sm uppercase tracking-widest text-text-muted">Conversation display</h3>

      <FontSizeControl
        label="Mobile font size"
        testIdPrefix="structured-mobile-font-size"
        value={settings.structuredMobileFontSize}
        onChange={(value) => update({ structuredMobileFontSize: value })}
        description="Font size for Structured View conversation content on mobile devices. Separate from the terminal font size, and shared with your other browsers like the rest of the dashboard preferences."
      />

      <FontSizeControl
        label="Desktop font size"
        testIdPrefix="structured-desktop-font-size"
        value={settings.structuredDesktopFontSize}
        onChange={(value) => update({ structuredDesktopFontSize: value })}
        description="Font size for Structured View conversation content on desktop devices. Separate from the terminal font size, and shared with your other browsers like the rest of the dashboard preferences."
      />

      <SelectField
        label="Thinking"
        description="How the agent's thinking shows in the conversation. Thinking is always recorded, so changing this also reveals or hides earlier turns. Each session can override it from its settings dialog."
        value={settings.thinkingDisplay}
        onChange={(value) => update({ thinkingDisplay: parseThinkingDisplay(value) ?? settings.thinkingDisplay })}
        options={THINKING_DISPLAYS.map((value) => ({ value, label: THINKING_DISPLAY_LABELS[value] }))}
      />
    </div>
  );
}
