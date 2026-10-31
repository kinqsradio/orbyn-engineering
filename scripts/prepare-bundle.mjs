// Builds the UI and the release service, then stages them for the Tauri bundle.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: windows, env });

const host = /host: (\S+)/.exec(
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
)[1];
const target = process.env.ORBYN_TARGET ?? host;

run("npm", ["run", "build"], join(root, "web"));
// A static C runtime, so the installer needs no redistributable.
const flags = target.includes("windows-msvc")
  ? { RUSTFLAGS: `${process.env.RUSTFLAGS ?? ""} -C target-feature=+crt-static`.trim() }
  : {};
run(
  "cargo",
  ["build", "--release", "-p", "orbynd", "--bin", "orbynd", "--bin", "orbyn", "--target", target],
  root,
  { ...process.env, ...flags },
);

const build = join(root, "build");
rmSync(build, { recursive: true, force: true });
mkdirSync(join(root, "desktop/src-tauri/binaries"), { recursive: true });
cpSync(join(root, "web/dist"), join(build, "ui"), { recursive: true });

const suffix = target.includes("windows") ? ".exe" : "";
for (const program of ["orbynd", "orbyn"]) {
  cpSync(
    join(root, "target", target, "release", `${program}${suffix}`),
    join(root, "desktop/src-tauri/binaries", `${program}-${target}${suffix}`),
  );
}
