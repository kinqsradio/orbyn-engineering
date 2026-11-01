// Builds the UI and the release service, then stages them for the Tauri bundle,
// along with a snapshot of the skills library so first launch needs no network.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// `git archive` reads objects, so links stay links on any host, and no checkout of the
// library is left to go stale. The license ships inside the archive and beside it.
const library = join(build, "library");
const [libraryUrl, revision] = readFileSync(join(root, "scripts/library.lock"), "utf8")
  .trim()
  .split(/\s+/);
const fetched = mkdtempSync(join(tmpdir(), "orbyn-library-"));
const git = (...args) => execFileSync("git", args, { cwd: fetched });
git("init", "--quiet", "--bare");
git("fetch", "--quiet", "--depth", "1", libraryUrl, revision);
mkdirSync(library, { recursive: true });
git("archive", "--format=tar", `--output=${join(library, "library.tar")}`, revision);
writeFileSync(join(library, "LICENSE"), git("show", `${revision}:LICENSE`));
writeFileSync(join(library, "REVISION"), `${revision}\n`);
rmSync(fetched, { recursive: true, force: true });

const suffix = target.includes("windows") ? ".exe" : "";
for (const program of ["orbynd", "orbyn"]) {
  cpSync(
    join(root, "target", target, "release", `${program}${suffix}`),
    join(root, "desktop/src-tauri/binaries", `${program}-${target}${suffix}`),
  );
}
