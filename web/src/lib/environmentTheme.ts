import type { EnvironmentTheme } from "../generated/EnvironmentTheme";
import { presetById } from "../features/settings/themes";
import { applyTheme, useUi } from "../state/ui";

/**
 * Applies the theme the environment publishes, once per time it was set. The
 * viewer's own later choice stays until the environment sets a theme again.
 */
export function adoptEnvironmentTheme(published: EnvironmentTheme | undefined): boolean {
  const ui = useUi.getState();
  if (!published || published.set_at <= ui.environmentThemeAppliedAt) return false;
  const { name } = published;
  const preset = presetById(name);
  if (name === "system" || name === "light" || name === "dark") {
    ui.setPrefs({ theme: name, environmentThemeAppliedAt: published.set_at });
  } else if (preset) {
    ui.setPrefs({
      theme: preset.scheme,
      [preset.scheme === "dark" ? "darkPreset" : "lightPreset"]: preset.id,
      environmentThemeAppliedAt: published.set_at,
    });
  } else {
    // An unknown name is recorded so it is not retried; the viewer's theme stays.
    ui.setPrefs({ environmentThemeAppliedAt: published.set_at });
    return false;
  }
  applyTheme(useUi.getState().theme);
  return true;
}
