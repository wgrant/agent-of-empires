import { useWebSettings } from "../../hooks/useWebSettings";
import { parseTimeFormat, TIME_FORMAT_LABELS, TIME_FORMATS } from "../../lib/timeFormatSetting";
import { SelectField } from "./FormFields";

/** The clock format, a dashboard preference stored in `aoe-web-settings`. */
export function TimeFormatSetting() {
  const { settings, update } = useWebSettings();
  return (
    <SelectField
      label="Time format"
      description="How clock times show. Automatic follows the clock setting of the machine running AoE when it has one, since browsers do not share yours, and otherwise your browser's language."
      value={settings.timeFormat}
      onChange={(value) => update({ timeFormat: parseTimeFormat(value) ?? settings.timeFormat })}
      options={TIME_FORMATS.map((value) => ({ value, label: TIME_FORMAT_LABELS[value] }))}
    />
  );
}
