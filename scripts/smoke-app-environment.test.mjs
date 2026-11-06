import assert from "node:assert/strict";
import test from "node:test";
import { posix, win32 } from "node:path";
import { smokeAppEnvironment } from "./smoke-app-environment.mjs";

test("packaged smoke disables host provider discovery even with an inherited selection", () => {
  const { environment } = smokeAppEnvironment({
    PATH: "/synthetic/host-tools",
    ORBYN_KNOWN_ENGINE_IDS: '["claude","codex"]',
  }, "/synthetic/smoke", "darwin");
  assert.equal(environment.ORBYN_KNOWN_ENGINE_IDS, "[]");
  assert.equal(environment.ORBYN_OFFLINE, "1");
});

for (const [platform, sandbox, paths] of [
  ["darwin", "/synthetic/smoke", posix],
  ["win32", "C:\\synthetic\\smoke", win32],
]) {
  test(`${platform} keeps every profile and temporary directory inside the smoke root`, () => {
    const parent = Object.freeze({
      HOME: "/synthetic/owner", USERPROFILE: "C:\\synthetic\\owner",
      CFFIXED_USER_HOME: "/synthetic/owner", APPDATA: "C:\\synthetic\\owner\\roaming",
      LOCALAPPDATA: "C:\\synthetic\\owner\\local", XDG_CONFIG_HOME: "/synthetic/config",
      XDG_DATA_HOME: "/synthetic/data", XDG_CACHE_HOME: "/synthetic/cache",
      XDG_STATE_HOME: "/synthetic/state", CODEX_HOME: "/synthetic/codex",
      CLAUDE_CONFIG_DIR: "/synthetic/claude", ORBYN_DATA_DIR: "/synthetic/orbyn",
      TEMP: "/synthetic/temp", TMP: "/synthetic/tmp", TMPDIR: "/synthetic/tmpdir",
    });
    const { environment, directories } = smokeAppEnvironment(parent, sandbox, platform);
    for (const key of Object.keys(parent)) {
      const relative = paths.relative(sandbox, environment[key]);
      assert.ok(relative && !relative.startsWith("..") && !paths.isAbsolute(relative), key);
      assert.ok(directories.includes(environment[key]), `${key} must be created before launch`);
    }
    assert.equal(environment.HOME, environment.USERPROFILE);
    assert.equal(environment.HOME, environment.CFFIXED_USER_HOME);
    assert.equal(environment.TEMP, environment.TMP);
    assert.equal(environment.TEMP, environment.TMPDIR);
    assert.equal(new Set(directories).size, directories.length);
    assert.equal(environment.ORBYN_STARTUP_DIAGNOSTICS, "1");
  });

  test(`${platform} drops synthetic credentials, endpoints, config and session overrides`, () => {
    const parent = Object.freeze({
      ANTHROPIC_API_KEY: "synthetic-key", OPENAI_API_KEY: "synthetic-key",
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token", OPENAI_BASE_URL: "https://synthetic.invalid",
      ORBYN_WORKSPACE_URL: "https://synthetic.invalid", ORBYN_UPDATE_ENDPOINT: "https://synthetic.invalid",
      ORBYN_TELEMETRY_INTERVAL_MS: "1", CLAUDECODE: "synthetic-session",
      CODEX_SANDBOX: "synthetic-session", NODE_OPTIONS: "--require /synthetic/hook.cjs",
      HTTP_PROXY: "https://synthetic.invalid", SSL_CERT_FILE: "/synthetic/certificate",
      claude_config_dir: "/synthetic/case-variant", appdata: "/synthetic/case-variant",
      orbyn_known_engine_ids: '["codex"]', UNKNOWN_SETTING: "synthetic-value",
    });
    const { environment } = smokeAppEnvironment(parent, sandbox, platform);
    for (const key of Object.keys(parent)) assert.equal(Object.hasOwn(environment, key), false, key);
    assert.equal(environment.ORBYN_KNOWN_ENGINE_IDS, "[]");
  });
}

test("Windows preserves required platform variables and canonicalizes their spelling", () => {
  const parent = Object.freeze({
    Path: "C:\\synthetic\\tools", systemroot: "C:\\Windows", systemdrive: "C:",
    windir: "C:\\Windows", comspec: "C:\\Windows\\System32\\cmd.exe",
    pathext: ".EXE;.CMD", lang: "en_US.UTF-8",
  });
  const { environment } = smokeAppEnvironment(parent, "C:\\synthetic\\smoke", "win32");
  for (const name of ["PATH", "SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "LANG"]) {
    const original = Object.keys(parent).find((key) => key.toUpperCase() === name.toUpperCase());
    assert.equal(environment[name], parent[original], name);
    assert.equal(Object.keys(environment).filter((key) => key.toUpperCase() === name.toUpperCase()).length, 1);
  }
});

for (const [platform, sandbox, paths] of [
  ["darwin", "/synthetic/smoke", posix],
  ["win32", "C:\\synthetic\\smoke", win32],
]) {
  test(`${platform} overrides built-in providers with absent leaves outside directory creation`, () => {
    const { environment, directories } = smokeAppEnvironment({
      PATH: "/synthetic/host-tools",
      ORBYN_CLAUDE_BIN: "/synthetic/host-claude",
      ORBYN_CODEX_BIN: "/synthetic/host-codex",
      orbyn_claude_bin: "/synthetic/lowercase-claude",
      orbyn_codex_bin: "/synthetic/lowercase-codex",
      orbyn_known_engine_ids: '["codex"]',
    }, sandbox, platform);
    for (const [name, leaf] of [["ORBYN_CLAUDE_BIN", "claude"], ["ORBYN_CODEX_BIN", "codex"]]) {
      assert.equal(environment[name], paths.join(sandbox, "absent-providers", leaf));
      assert.ok(paths.isAbsolute(environment[name]));
      assert.equal(Object.hasOwn(environment, name.toLowerCase()), false);
      // No mkdir target can create the executable leaf, even as an ancestor.
      for (const directory of directories) {
        const relative = paths.relative(environment[name], directory);
        assert.ok(relative.startsWith("..") || paths.isAbsolute(relative));
      }
    }
    assert.equal(directories.includes(paths.join(sandbox, "absent-providers")), false);
    assert.equal(environment.ORBYN_KNOWN_ENGINE_IDS, "[]");
    assert.equal(environment.PATH, "/synthetic/host-tools");
  });
}

test("Windows emits only one PATH when the synthetic parent contains multiple spellings", () => {
  const { environment } = smokeAppEnvironment({ PATH: "canonical", Path: "duplicate" }, "C:\\synthetic\\smoke", "win32");
  assert.equal(environment.PATH, "canonical");
  assert.equal(Object.hasOwn(environment, "Path"), false);
});

test("macOS preserves exact runtime names without promoting unrelated case variants", () => {
  const { environment } = smokeAppEnvironment({
    PATH: "/synthetic/tools", LANG: "en_US.UTF-8", Path: "/synthetic/other", lang: "other",
  }, "/synthetic/smoke", "darwin");
  assert.equal(environment.PATH, "/synthetic/tools");
  assert.equal(environment.LANG, "en_US.UTF-8");
  assert.equal(Object.hasOwn(environment, "Path"), false);
  assert.equal(Object.hasOwn(environment, "lang"), false);
});

for (const [platform, sandbox, codexBin] of [
  ["darwin", "/synthetic/smoke", "/synthetic/install/node_modules/.bin/codex"],
  ["win32", "C:\\synthetic\\smoke", "C:\\synthetic\\install\\node_modules\\.bin\\codex.cmd"],
]) {
  test(`${platform} takes only an explicit Codex, never the parent's`, () => {
    const parent = { PATH: "/synthetic/tools", ORBYN_CODEX_BIN: "/synthetic/host-codex", CODEX_HOME: "/synthetic/owner-codex" };
    const { environment } = smokeAppEnvironment(parent, sandbox, platform, { codexBin });
    assert.equal(environment.ORBYN_CODEX_BIN, codexBin);
    assert.notEqual(environment.CODEX_HOME, parent.CODEX_HOME);
    assert.ok(environment.ORBYN_CLAUDE_BIN.includes("absent-providers"));
    assert.throws(() => smokeAppEnvironment(parent, sandbox, platform, { codexBin: "codex" }), /absolute/);
  });
}
