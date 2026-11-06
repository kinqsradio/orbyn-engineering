import { posix, win32 } from "node:path";

/**
 * Builds the packaged smoke profile without reading host configuration.
 * `codexBin` names a Codex the caller installed on purpose; the parent's own
 * provider overrides are never taken.
 */
export function smokeAppEnvironment(parent, sandbox, platform = process.platform, { codexBin } = {}) {
  const { join, isAbsolute } = platform === "win32" ? win32 : posix;
  if (codexBin !== undefined && !isAbsolute(codexBin)) throw new Error("The smoke's Codex must be an absolute path.");
  const home = join(sandbox, "home");
  const kept = ["PATH", "SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "LANG"];
  const inherited = {};
  for (const name of kept) {
    // Windows environment names are case-insensitive. Emit one spelling only.
    const key = Object.hasOwn(parent, name) ? name : platform === "win32"
      ? Object.keys(parent).find((key) => key.toUpperCase() === name.toUpperCase())
      : undefined;
    if (key !== undefined && parent[key]) inherited[name] = parent[key];
  }
  const profile = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    TEMP: join(sandbox, "temp"),
    TMP: join(sandbox, "temp"),
    TMPDIR: join(sandbox, "temp"),
    ORBYN_DATA_DIR: join(sandbox, "data"),
  };
  const environment = {
    ...inherited,
    ...profile,
    // Built-in providers are registered even when optional discovery is empty.
    // Explicit missing overrides prevent them from resolving the host PATH.
    ORBYN_CLAUDE_BIN: join(sandbox, "absent-providers", "claude"),
    ORBYN_CODEX_BIN: codexBin ?? join(sandbox, "absent-providers", "codex"),
    // Offline stops update lookups, not discovery of installed provider CLIs.
    ORBYN_KNOWN_ENGINE_IDS: "[]",
    ORBYN_OFFLINE: "1",
    ORBYN_STARTUP_DIAGNOSTICS: "1",
  };
  return { environment, directories: [...new Set(Object.values(profile))] };
}
