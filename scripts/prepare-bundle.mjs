// Builds the UI and the release service, then stages them for the Tauri bundle.
// Skills are copied from the outer library into ignored build output only.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: "inherit", shell: windows });

const host = /host: (\S+)/.exec(
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
)[1];
const target = process.env.ORBYN_TARGET ?? host;
const skills = process.env.ORBYN_SKILLS_DIR ?? resolve(root, "../../skills");
if (!existsSync(join(skills, "catalog.json"))) {
  throw new Error(`Skill library not found at ${skills}. Set ORBYN_SKILLS_DIR.`);
}

run("npm", ["run", "build"], join(root, "web"));
run("cargo", ["build", "--release", "-p", "orbynd", "--target", target], root);

const build = join(root, "build");
rmSync(build, { recursive: true, force: true });
mkdirSync(join(root, "desktop/src-tauri/binaries"), { recursive: true });
cpSync(join(root, "web/dist"), join(build, "ui"), { recursive: true });
cpSync(skills, join(build, "skills"), { recursive: true });

const suffix = target.includes("windows") ? ".exe" : "";
cpSync(
  join(root, "target", target, "release", `orbynd${suffix}`),
  join(root, "desktop/src-tauri/binaries", `orbynd-${target}${suffix}`),
);
