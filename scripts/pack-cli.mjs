// Packs the `orbyn` command for install.sh and install.ps1: `orbyn`, `orbynd`, the UI and
// the library snapshot in one folder, as `orbyn` expects them beside itself, plus a
// .sha256 the installers check. Run after prepare-bundle.
// Usage: node scripts/pack-cli.mjs <target> <out-dir>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The system tar on Windows takes drive paths; a Git or MSYS tar earlier on PATH does not.
const tar =
  process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

export function packCli({ target, binaries, build, out }) {
  const suffix = target.includes("windows") ? ".exe" : "";
  const stage = mkdtempSync(join(tmpdir(), "orbyn-cli-"));
  try {
    for (const program of ["orbyn", "orbynd"]) {
      cpSync(join(binaries, `${program}${suffix}`), join(stage, `${program}${suffix}`));
    }
    for (const folder of ["ui", "library"]) {
      cpSync(join(build, folder), join(stage, folder), { recursive: true });
    }
    mkdirSync(out, { recursive: true });
    const archive = join(out, `orbyn-cli-${target}.tar.gz`);
    execFileSync(tar, ["-czf", archive, "-C", stage, "."]);
    const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(`${archive}.sha256`, `${sum}  ${basename(archive)}\n`);
    return archive;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [target, out] = process.argv.slice(2);
  if (!target || !out) throw new Error("Usage: pack-cli.mjs <target> <out-dir>");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(
    packCli({
      target,
      binaries: join(root, "target", target, "release"),
      build: join(root, "build"),
      out: resolve(out),
    }),
  );
}
