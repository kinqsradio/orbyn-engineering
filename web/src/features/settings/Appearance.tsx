import { MAX_PANEL_ANIMATION_MS } from "../../lib/panelAnimations";
import { useUi, type ThemeChoice } from "../../state/ui";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function AppearanceSection() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const panelMs = useUi((state) => state.panelAnimationMs);
  const setPanelMs = useUi((state) => state.setPanelAnimationMs);
  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Appearance
      </h1>
      <SettingGroup title="Theme">
        <SettingRow title="Theme" description="How the app looks on this device.">
          <select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeChoice)}>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Motion">
        <SettingRow
          title={`Panel animations: ${panelMs === 0 ? "Off" : `${panelMs} ms`}`}
          description="Animates panels opening and the composer moving."
        >
          <input
            type="range"
            aria-label="Panel animations"
            min={0}
            max={MAX_PANEL_ANIMATION_MS}
            step={20}
            value={panelMs}
            onChange={(event) => setPanelMs(Number(event.target.value))}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
