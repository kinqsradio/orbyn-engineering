// Runs scripts/verify-macos-release.sh against fake `xcrun`, `spctl` and `sleep`, so
// the credential gate, the stapling retry and the Gatekeeper calls are checked without
// a Developer ID build. The fakes log every call and fail stapling a set number of times.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "verify-macos-release.sh");
const skip = process.platform === "win32" && "the notarization check runs on macOS only";

const credentials = {
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example (TEAM123456)",
  APPLE_ID: "notary@example.invalid",
  APPLE_PASSWORD: "not-a-real-password",
  APPLE_TEAM_ID: "TEAM123456",
};

function run(args, env, { stapleFailures = 0 } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "orbyn-notary-"));
  const log = join(bin, "calls.log");
  const count = join(bin, "staple.count");
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake(
    "xcrun",
    `if [ "$1 $2" = "stapler staple" ]; then
  n=$(( $(cat "${count}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${count}"
  [ "$n" -gt ${stapleFailures} ] || exit 65
fi
exit 0`,
  );
  fake("spctl", "exit 0");
  fake("sleep", "exit 0");
  const result = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {}
  rmSync(bin, { recursive: true, force: true });
  return { ...result, calls };
}

test("an ad-hoc build has nothing to check", { skip }, () => {
  const result = run(["Orbyn.app"], { APPLE_SIGNING_IDENTITY: "-" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Not a Developer ID build/);
  assert.deepEqual(result.calls, []);
});

for (const missing of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"]) {
  test(`a Developer ID build without ${missing} fails before stapling`, { skip }, () => {
    const env = { ...credentials };
    delete env[missing];
    const result = run(["Orbyn.app"], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`needs ${missing}`));
    assert.deepEqual(result.calls, []);
  });
}

test("stapling is retried, then the app and the disk image are assessed", { skip }, () => {
  const result = run(["Orbyn.app", "Orbyn.dmg"], credentials, { stapleFailures: 2 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [
    "xcrun stapler staple Orbyn.app",
    "sleep 30",
    "xcrun stapler staple Orbyn.app",
    "sleep 60",
    "xcrun stapler staple Orbyn.app",
    "xcrun stapler validate Orbyn.app",
    "spctl --assess --type execute --verbose Orbyn.app",
    "xcrun stapler staple Orbyn.dmg",
    "xcrun stapler validate Orbyn.dmg",
    "spctl --assess --type open --context context:primary-signature --verbose Orbyn.dmg",
  ]);
});

test("a ticket that never arrives fails after five tries", { skip }, () => {
  const result = run(["Orbyn.app"], credentials, { stapleFailures: 99 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No ticket for Orbyn\.app/);
  assert.equal(result.calls.filter((call) => call.startsWith("xcrun stapler staple")).length, 5);
  assert.ok(!result.calls.some((call) => call.startsWith("spctl")));
});
