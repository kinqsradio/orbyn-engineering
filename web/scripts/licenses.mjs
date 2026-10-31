#!/usr/bin/env node
/** Writes the direct dependencies of the web client and the service, for About. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(web, "package.json"), "utf8"));
const scripts = Object.keys(manifest.dependencies).map((name) => {
  const installed = JSON.parse(readFileSync(resolve(web, "node_modules", name, "package.json"), "utf8"));
  return { name, version: installed.version, license: installed.license ?? "See package" };
});
const cargo = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    cwd: resolve(web, ".."),
    maxBuffer: 1 << 28,
    encoding: "utf8",
  }),
);
const ours = new Set(cargo.workspace_members);
const wanted = new Set(
  cargo.packages.filter((entry) => ours.has(entry.id)).flatMap((entry) => entry.dependencies.filter((dep) => dep.kind === null).map((dep) => dep.name)),
);
const crates = cargo.packages
  .filter((entry) => !ours.has(entry.id) && wanted.has(entry.name))
  .map(({ name, version, license }) => ({ name, version, license: license ?? "See crate" }));
const byName = (a, b) => a.name.localeCompare(b.name);
writeFileSync(
  resolve(web, "src/features/settings/licenses.json"),
  `${JSON.stringify({ scripts: scripts.sort(byName), crates: crates.sort(byName) }, null, 2)}\n`,
);
