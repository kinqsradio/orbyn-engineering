import { settingsLabel } from "./settingsSearch";
import { Info } from "lucide-react";
import { useRef, useState } from "react";
import { MAX_PANEL_ANIMATION_MS } from "../../lib/panelAnimations";
import { applyTheme, useUi, type LayoutChoice, type ThemeChoice, type Typography } from "../../state/ui";
import { Button } from "../../ui/controls";
import { Segmented } from "../../ui/Segmented";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { parseThemeFile, THEME_PRESETS, THEME_TOKENS, type ThemeColors } from "../../styles/themes";
import { ENVIRONMENT_ICON_CHOICES } from "./EnvironmentIcon";
import { PreferenceGroups } from "./PreferenceRows";

/** What this environment publishes to every viewer, and when its theme was set. */
function EnvironmentGroup() {
  const themeChoices = [
    { value: "", label: "None" },
    ...choices.map((choice) => ({ value: choice.value, label: choice.label })),
    ...THEME_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
  ];
  return (
    <>
    <p className="settings-scope"><Info size={13} aria-hidden />Published to every viewer of this computer</p>
    <PreferenceGroups
      groups={[
        {
          title: "",
          rows: [
            {
              key: "default_theme",
              title: settingsLabel("appearance-default-theme"),
              description: "The theme a viewer starts with",
              options: themeChoices,
            },
            {
              key: "environment_icon",
              title: settingsLabel("appearance-environment-icon"),
              description: "Shown next to this computer’s name",
              options: ENVIRONMENT_ICON_CHOICES,
            },
          ],
        },
      ]}
    />
    <p className="banner"><Info size={13} aria-hidden />Anyone who opens this computer’s threads from another device sees this theme and icon.</p>
    </>
  );
}

type LayoutOption = { value: LayoutChoice; label: string; description: string; columns: string; rows?: string; cells: { span?: boolean; lead?: boolean; inset?: boolean }[] };

const CONSOLE: LayoutOption = {
  value: "console",
  label: "Console",
  description: "Sidebar, thread, side panel",
  columns: "22% 1fr 30%",
  cells: [{}, {}, {}],
};

const LAYOUTS: LayoutOption[] = [
  CONSOLE,
  {
    value: "ledger",
    label: "Ledger",
    description: "What needs you first",
    columns: "24% 1fr 22%",
    rows: "14px 1fr",
    cells: [{ span: true, lead: true }, { lead: true }, { span: true }, {}],
  },
  { value: "reading", label: "Reading", description: "One calm column", columns: "8% 1fr", cells: [{}, { inset: true }] },
];

/** A layout preset: it sets the arrangement and the few panel defaults that go with it. */
function LayoutRow() {
  const layout = useUi((state) => state.workspaceLayout);
  const theme = useUi((state) => state.theme);
  const setPrefs = useUi((state) => state.setPrefs);
  const current = LAYOUTS.find((choice) => choice.value === layout) ?? CONSOLE;
  const choose = (value: LayoutChoice) => {
    if (value === "ledger") setPrefs({ workspaceLayout: value, sidebarCollapsed: false, detailsOpen: true });
    else if (value === "reading") setPrefs({ workspaceLayout: value, sidebarCollapsed: true, chatWidth: "comfortable" });
    else setPrefs({ workspaceLayout: value, sidebarCollapsed: false });
    applyTheme(theme);
  };
  return (
    <SettingRow title={settingsLabel("appearance-layout")} stacked>
      <div
        className="layout-cards"
        role="radiogroup"
        aria-label="Layout"
        onKeyDown={(event) => {
          const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
          if (!step) return;
          event.preventDefault();
          const next = LAYOUTS[(LAYOUTS.indexOf(current) + step + LAYOUTS.length) % LAYOUTS.length];
          if (!next) return;
          choose(next.value);
          requestAnimationFrame(() => event.currentTarget.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
        }}
      >
        {LAYOUTS.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            className="layout-card"
            aria-checked={choice.value === current.value}
            tabIndex={choice.value === current.value ? 0 : -1}
            onClick={() => choose(choice.value)}
          >
            <span className="layout-mini" aria-hidden style={{ gridTemplateColumns: choice.columns, gridTemplateRows: choice.rows }}>
              {choice.cells.map((cell, at) => (
                <i key={at} className={cell.lead ? "lead" : undefined} data-span={cell.span || undefined} data-inset={cell.inset || undefined} />
              ))}
            </span>
            <b>{choice.label}</b>
            <span>{choice.description}</span>
          </button>
        ))}
      </div>
    </SettingRow>
  );
}

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

type LookChoice = ThemeChoice | "dim";
const LOOKS: { value: LookChoice; label: string }[] = [...choices, { value: "dim", label: "Dim" }];

/** System, Light, Dark and Dim; Dim is the dark theme with the Dim preset. */
function ThemeChoiceRow() {
  const theme = useUi((state) => state.theme);
  const darkPreset = useUi((state) => state.darkPreset);
  const setTheme = useUi((state) => state.setTheme);
  const setPrefs = useUi((state) => state.setPrefs);
  const value: LookChoice = theme === "dark" && darkPreset === "dim" ? "dim" : theme;
  const choose = (next: LookChoice) => {
    if (next === "dim") {
      setPrefs({ darkPreset: "dim" });
      setTheme("dark");
      applyTheme("dark");
      return;
    }
    if (next === "dark" && darkPreset === "dim") setPrefs({ darkPreset: null });
    setTheme(next);
    applyTheme(next);
  };
  return (
    <SettingRow title={settingsLabel("appearance-theme")}>
      <Segmented label="Theme" value={value} options={LOOKS} onChange={choose} />
    </SettingRow>
  );
}

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
        <option value="">{scheme === "dark" ? "Orbyn Dark" : "Orbyn Light"}</option>
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

/** A free-text font name; empty means the default. */
function FontRow({ title, label, value, save }: { title: string; label: string; value: string; save(next: string): void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(value); }
  return (
    <SettingRow title={title}>
      <input aria-label={label} placeholder="Any installed font" value={draft} spellCheck={false}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft.trim() !== value) save(draft.trim()); }} />
      {value !== "" ? <Button small tone="quiet" aria-label={`Reset ${label} to default`} onClick={() => { setDraft(""); save(""); }}>Reset to default</Button> : null}
    </SettingRow>
  );
}

function FontRows() {
  const typography = useUi((state) => state.typography);
  const theme = useUi((state) => state.theme);
  const setPrefs = useUi((state) => state.setPrefs);
  const update = (patch: Partial<Typography>) => {
    setPrefs({ typography: { ...typography, ...patch } });
    applyTheme(theme);
  };
  return (
    <SettingGroup>
      <FontRow title={settingsLabel("appearance-interface-font")} label="Interface font" value={typography.uiFont} save={(uiFont) => update({ uiFont })} />
      <FontRow title={settingsLabel("appearance-code-font")} label="Code font" value={typography.codeFont} save={(codeFont) => update({ codeFont })} />
    </SettingGroup>
  );
}

const SIZE_DEFAULTS: Record<keyof Typography & string, number> = { uiSize: 16, chatSize: 14, codeSize: 13, terminalSize: 12 } as never;
const SIZE_NOTES: Record<string, string> = {
  uiSize: "Sidebar, settings and menus. Applied as page zoom: 16 = 100%.",
  chatSize: "Messages and tool calls",
  codeSize: "Diffs, code blocks and files",
  terminalSize: "The terminal drawer",
};

function TypographyGroup() {
  const typography = useUi((state) => state.typography);
  const theme = useUi((state) => state.theme);
  const setPrefs = useUi((state) => state.setPrefs);
  const update = (patch: Partial<Typography>) => {
    setPrefs({ typography: { ...typography, ...patch } });
    applyTheme(theme);
  };
  return (
    <>
      <SettingGroup>
        {SIZES.map(({ key, title, min, max }) => (
          <SettingRow key={key} title={title} description={SIZE_NOTES[key]}>
            <span className="unit-field">
              <span className="t3 range-note">{min}–{max} · default {SIZE_DEFAULTS[key]}</span>
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
              <span className="t3">px</span>
              <Button small disabled={typography[key] === SIZE_DEFAULTS[key]} aria-label={`Reset ${title}`} onClick={() => update({ [key]: SIZE_DEFAULTS[key] })}>Reset</Button>
            </span>
          </SettingRow>
        ))}
      </SettingGroup>
      <div className="set-card set-preview">
        <small className="t3">Preview</small>
        <span style={{ fontSize: typography.chatSize }}>The redirect ignores the next parameter.</span>
        <span className="mono" style={{ fontSize: typography.codeSize }}>const next = params.get("next");</span>
      </div>
    </>
  );
}

export function AppearanceSection() {
  const theme = useUi((state) => state.theme);
  const panelMs = useUi((state) => state.panelAnimationMs);
  const setPanelMs = useUi((state) => state.setPanelAnimationMs);
  const effortDisplay = useUi((state) => state.effortDisplay);
  const setPrefs = useUi((state) => state.setPrefs);
  const contrast = useUi((state) => state.contrast);
  const smoothing = useUi((state) => state.fontSmoothing);
  const environmentIdentification = useUi((state) => state.environmentIdentification);
  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Appearance
      </h1>
      <SettingGroup>
        <ThemeChoiceRow />
      </SettingGroup>
      <SettingGroup>
        <LayoutRow />
      </SettingGroup>
      <FontRows />
      <TypographyGroup />
      <SettingGroup>
        <PresetRow scheme="light" />
        <PresetRow scheme="dark" />
        <SettingRow title={settingsLabel("appearance-contrast")}>
          <Segmented
            label="Contrast"
            value={contrast}
            options={[
              { value: "normal", label: "Standard" },
              { value: "more", label: "Higher" },
            ]}
            onChange={(next) => {
              setPrefs({ contrast: next });
              applyTheme(theme);
            }}
          />
        </SettingRow>
        <SettingRow title={settingsLabel("appearance-font-smoothing")} description="Smooth text on macOS">
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
        <SettingRow title={settingsLabel("appearance-effort-display")} description="How effort shows in the composer">
          <Segmented
            label="Effort display"
            value={effortDisplay}
            options={[
              { value: "label", label: "Name" },
              { value: "bars", label: "Bars" },
            ]}
            onChange={(next) => setPrefs({ effortDisplay: next })}
          />
        </SettingRow>
        <SettingRow
          settingId="appearance-panel-animations"
          title={settingsLabel("appearance-panel-animations")}
          description="How long the side panel takes to open. 0 turns it off."
        >
          <span className="unit-field">
            <input
              type="number"
              aria-label="Panel animations"
              min={0}
              max={MAX_PANEL_ANIMATION_MS}
              step={20}
              value={panelMs}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (next >= 0 && next <= MAX_PANEL_ANIMATION_MS) setPanelMs(next);
              }}
            />
            <span className="t3">ms</span>
          </span>
        </SettingRow>
      </SettingGroup>
      <EnvironmentGroup />
      <SettingGroup>
        <SettingRow title={settingsLabel("appearance-environment-identification")} description="How the sidebar marks a Dev or Nightly build of this environment.">
          <Segmented
            label="Environment identification"
            value={environmentIdentification}
            options={[
              { value: "artwork", label: "Artwork" },
              { value: "pill", label: "Version pill" },
              { value: "none", label: "None" },
            ]}
            onChange={(next) => setPrefs({ environmentIdentification: next })}
          />
        </SettingRow>
      </SettingGroup>
      <ThemeEditor />
    </>
  );
}
