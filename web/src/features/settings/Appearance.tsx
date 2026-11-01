import { settingsLabel } from "./settingsSearch";
import { useRef } from "react";
import { MAX_PANEL_ANIMATION_MS } from "../../lib/panelAnimations";
import { applyTheme, useUi, type ThemeChoice, type Typography } from "../../state/ui";
import { Button } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { parseThemeFile, THEME_PRESETS, THEME_TOKENS, type ThemeColors } from "./themes";

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function PresetRow({ scheme }: { scheme: "light" | "dark" }) {
  const key = scheme === "dark" ? "darkPreset" : "lightPreset";
  const value = useUi((state) => state[key]);
  const theme = useUi((state) => state.theme);
  const setPrefs = useUi((state) => state.setPrefs);
  const title = settingsLabel(scheme === "dark" ? "appearance-dark-theme" : "appearance-light-theme");
  return (
    <SettingRow title={title}>
      <select
        aria-label={title}
        value={value ?? ""}
        onChange={(event) => {
          setPrefs({ [key]: event.target.value || null });
          applyTheme(theme);
        }}
      >
        <option value="">Orbyn</option>
        {THEME_PRESETS.filter((preset) => preset.scheme === scheme).map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.name}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

function ThemeEditor() {
  const custom = useUi((state) => state.customColors);
  const theme = useUi((state) => state.theme);
  const setPrefs = useUi((state) => state.setPrefs);
  const pushToast = useUi((state) => state.pushToast);
  const file = useRef<HTMLInputElement>(null);
  const save = (customColors: ThemeColors) => {
    setPrefs({ customColors });
    applyTheme(theme);
  };
  const exportTheme = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ colors: custom }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "orbyn-theme.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  const importTheme = async (selected: File | undefined) => {
    if (!selected) return;
    const colors = parseThemeFile(await selected.text());
    if (colors) save(colors);
    else pushToast("Couldn't read that theme file.");
    if (file.current) file.current.value = "";
  };
  return (
    <SettingGroup title="Theme editor">
      {THEME_TOKENS.map(([token, label]) => (
        <SettingRow key={token} title={label}>
          <input
            type="color"
            aria-label={label}
            value={custom[token] ?? (getComputedStyle(document.documentElement).getPropertyValue(token).trim().match(/^#[0-9a-f]{6}$/i)?.[0] ?? "#000000")}
            onChange={(event) => save({ ...custom, [token]: event.target.value })}
          />
        </SettingRow>
      ))}
      <SettingRow title={settingsLabel("appearance-theme-file")}>
        <input ref={file} type="file" accept="application/json,.json" hidden aria-label="Import theme file" onChange={(event) => void importTheme(event.target.files?.[0])} />
        <Button small tone="quiet" onClick={() => file.current?.click()}>
          Import
        </Button>
        <Button small tone="quiet" onClick={exportTheme}>
          Export
        </Button>
        <Button small tone="quiet" disabled={Object.keys(custom).length === 0} onClick={() => save({})}>
          Reset
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}

const SIZES: { key: keyof Typography; title: string; min: number; max: number }[] = [
  { key: "uiSize", title: settingsLabel("appearance-interface-size"), min: 12, max: 22 },
  { key: "chatSize", title: settingsLabel("appearance-chat-size"), min: 11, max: 22 },
  { key: "codeSize", title: settingsLabel("appearance-code-size"), min: 10, max: 22 },
  { key: "terminalSize", title: settingsLabel("appearance-terminal-size"), min: 8, max: 24 },
];

function TypographyGroup() {
  const typography = useUi((state) => state.typography);
  const theme = useUi((state) => state.theme);
  const setPrefs = useUi((state) => state.setPrefs);
  const update = (patch: Partial<Typography>) => {
    setPrefs({ typography: { ...typography, ...patch } });
    applyTheme(theme);
  };
  return (
    <SettingGroup title="Typography">
      <SettingRow title={settingsLabel("appearance-interface-font")}>
        <input aria-label="Interface font" placeholder="System" defaultValue={typography.uiFont} onBlur={(event) => update({ uiFont: event.target.value.trim() })} />
      </SettingRow>
      <SettingRow title={settingsLabel("appearance-code-font")}>
        <input aria-label="Code font" placeholder="System" defaultValue={typography.codeFont} onBlur={(event) => update({ codeFont: event.target.value.trim() })} />
      </SettingRow>
      {SIZES.map(({ key, title, min, max }) => (
        <SettingRow key={key} title={title}>
          <input
            type="number"
            aria-label={title}
            min={min}
            max={max}
            value={typography[key]}
            onChange={(event) => {
              const size = Number(event.target.value);
              if (size >= min && size <= max) update({ [key]: size });
            }}
          />
        </SettingRow>
      ))}
    </SettingGroup>
  );
}

export function AppearanceSection() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const panelMs = useUi((state) => state.panelAnimationMs);
  const setPanelMs = useUi((state) => state.setPanelAnimationMs);
  const effortDisplay = useUi((state) => state.effortDisplay);
  const setPrefs = useUi((state) => state.setPrefs);
  const contrast = useUi((state) => state.contrast);
  const smoothing = useUi((state) => state.fontSmoothing);
  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Appearance
      </h1>
      <SettingGroup title="Theme">
        <SettingRow title={settingsLabel("appearance-theme")} description="How the app looks on this device.">
          <select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeChoice)}>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Theme presets">
        <PresetRow scheme="dark" />
        <PresetRow scheme="light" />
        <SettingRow title={settingsLabel("appearance-contrast")}>
          <select
            aria-label="Contrast"
            value={contrast}
            onChange={(event) => {
              setPrefs({ contrast: event.target.value as "normal" | "more" });
              applyTheme(theme);
            }}
          >
            <option value="normal">Normal</option>
            <option value="more">More</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("appearance-font-smoothing")}>
          <input
            type="checkbox"
            role="switch"
            aria-label="Font smoothing"
            checked={smoothing}
            onChange={(event) => {
              setPrefs({ fontSmoothing: event.target.checked });
              applyTheme(theme);
            }}
          />
        </SettingRow>
      </SettingGroup>
      <ThemeEditor />
      <TypographyGroup />
      <SettingGroup title="Composer">
        <SettingRow title={settingsLabel("appearance-effort-display")} description="Show reasoning effort in the composer as its name, such as High, or as bars.">
          <select
            aria-label="Effort display"
            value={effortDisplay}
            onChange={(event) => setPrefs({ effortDisplay: event.target.value as "label" | "bars" })}
          >
            <option value="label">Word</option>
            <option value="bars">Bars</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Motion">
        <SettingRow
          settingId="appearance-panel-animations"
          title={`${settingsLabel("appearance-panel-animations")}: ${panelMs === 0 ? "Off" : `${panelMs} ms`}`}
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
