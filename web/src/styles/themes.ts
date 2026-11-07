/** The colours a theme sets; everything else derives from these tokens. */
export const THEME_TOKENS = [
  ["--color-background", "Background"],
  ["--color-sidebar", "Sidebar"],
  ["--color-raised", "Raised surface"],
  ["--color-border", "Border"],
  ["--color-text", "Text"],
  ["--color-muted", "Muted text"],
  ["--color-primary", "Accent"],
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number][0];
export type ThemeColors = Partial<Record<ThemeToken, string>>;

export interface ThemePreset {
  id: string;
  name: string;
  scheme: "light" | "dark";
  colors: ThemeColors;
  /** True when tokens.css holds the preset's full token set (`data-preset`), so no inline colours apply. */
  tokens?: boolean;
}

const palette = (id: string, name: string, scheme: "light" | "dark", values: readonly string[]): ThemePreset => ({
  id,
  name,
  scheme,
  colors: Object.fromEntries(THEME_TOKENS.map(([token], at) => [token, values[at] ?? ""])),
});

export const THEME_PRESETS: ThemePreset[] = [
  // Dim's real values live in tokens.css; these swatches only describe it.
  { ...palette("dim", "Dim", "dark", ["#161616", "#101010", "#1c1c1c", "#2a2a2a", "#ebebeb", "#a3a3a3", "#f2f2f2"]), tokens: true },
  palette("dusk", "Dusk", "dark", ["#14161c", "#101217", "#1c1f27", "#2a2e38", "#e6e8ee", "#9aa1b1", "#7aa2f7"]),
  palette("forest", "Forest", "dark", ["#111814", "#0d130f", "#18211b", "#26332a", "#e3ece5", "#93a698", "#6fcf97"]),
  palette("ember", "Ember", "dark", ["#191412", "#14100e", "#231c19", "#352b26", "#efe6e0", "#ab9c93", "#f2994a"]),
  palette("paper", "Paper", "light", ["#fbfaf6", "#f4f2ec", "#ffffff", "#e3dfd4", "#26231c", "#6f6a5d", "#3b6fd4"]),
  palette("mist", "Mist", "light", ["#f6f8fa", "#eef1f4", "#ffffff", "#d9dfe6", "#1b2229", "#5c6773", "#0a7ea4"]),
];

export const presetById = (id: string | null) => THEME_PRESETS.find((preset) => preset.id === id) ?? null;

const HEX = /^#[0-9a-f]{6}$/i;
const COLOUR = /^(#([0-9a-f]{3}|[0-9a-f]{6})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+|1\.0+)\s*)?\))$/i;
/** A colour a token may hold: #rgb, #rrggbb or rgb()/rgba(). */
export const isColour = (value: string) => COLOUR.test(value.trim());

export type ThemeRead = { colors: ThemeColors } | { error: string };

/** Reads a theme file and says why it can't be used; nothing is applied here. */
export function readThemeFile(text: string): ThemeRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "It isn't valid JSON." };
  }
  if (!value || typeof value !== "object") return { error: "It isn't a theme file." };
  const body = value as { colors?: Record<string, unknown> } & Record<string, unknown>;
  const colors = body.colors ?? body;
  const lines = text.split("\n");
  const out: ThemeColors = {};
  for (const [key, raw] of Object.entries(colors)) {
    const token = (THEME_TOKENS.find(([name]) => name === key) ?? [null, null])[0] ?? VSCODE_TOKENS[key] ?? null;
    if (!token) continue;
    if (typeof raw !== "string" || !isColour(raw)) {
      const at = lines.findIndex((line) => line.includes(`"${key}"`));
      const label = THEME_TOKENS.find(([name]) => name === token)?.[1] ?? key;
      return { error: `${at >= 0 ? `Line ${at + 1}: ` : ""}“${label}” is not a colour.` };
    }
    out[token] = raw.trim();
  }
  return Object.keys(out).length > 0 ? { colors: out } : { error: "It has no colours Orbyn knows." };
}

const VSCODE_TOKENS: Record<string, ThemeToken> = {
  "editor.background": "--color-background",
  "sideBar.background": "--color-sidebar",
  "editorWidget.background": "--color-raised",
  "panel.border": "--color-border",
  "editor.foreground": "--color-text",
  descriptionForeground: "--color-muted",
  focusBorder: "--color-primary",
};

/** Reads a theme file: our shape, or a VS Code theme's `colors` map. */
export function parseThemeFile(text: string): ThemeColors | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const body = value as { colors?: Record<string, unknown> } & Record<string, unknown>;
  const colors = body.colors ?? body;
  const vscode: Record<string, ThemeToken> = {
    "editor.background": "--color-background",
    "sideBar.background": "--color-sidebar",
    "editorWidget.background": "--color-raised",
    "panel.border": "--color-border",
    "editor.foreground": "--color-text",
    descriptionForeground: "--color-muted",
    focusBorder: "--color-primary",
  };
  const out: ThemeColors = {};
  for (const [key, raw] of Object.entries(colors)) {
    const token = vscode[key] ?? (THEME_TOKENS.some(([name]) => name === key) ? (key as ThemeToken) : null);
    if (token && typeof raw === "string" && HEX.test(raw)) out[token] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}
