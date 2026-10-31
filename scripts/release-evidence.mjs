// Writes what a release must carry beside its files: a SHA-256 for each asset and a
// CycloneDX inventory from the lockfiles. A release with nothing to list fails: an
// empty scan is an incomplete one, never a clean one.
// Usage: node scripts/release-evidence.mjs <out-dir> <asset>...
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `[[package]]` entries from a Cargo.lock. */
export function cargoPackages(text) {
  return text
    .split("[[package]]")
    .slice(1)
    .map((block) => ({
      name: /^name = "(.+)"$/m.exec(block)?.[1],
      version: /^version = "(.+)"$/m.exec(block)?.[1],
      external: /^source = /m.test(block),
    }))
    .filter((entry) => entry.name && entry.version && entry.external)
    .map(({ name, version }) => ({ name, version, purl: `pkg:cargo/${name}@${version}` }));
}

/** Installed packages from an npm lockfile, version 2 or later. */
export function npmPackages(text) {
  return Object.entries(JSON.parse(text).packages ?? {})
    .filter(([path, entry]) => path.includes("node_modules/") && entry.version && !entry.link)
    .map(([path, entry]) => {
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      return { name, version: entry.version, purl: `pkg:npm/${name.replace("@", "%40")}@${entry.version}` };
    });
}

export function inventory(sources) {
  const seen = new Map();
  for (const source of sources) {
    if (source.packages.length === 0) throw new Error(`Incomplete: ${source.file} listed nothing.`);
    for (const entry of source.packages) seen.set(entry.purl, entry);
  }
  const components = [...seen.values()]
    .sort((left, right) => left.purl.localeCompare(right.purl))
    .map(({ name, version, purl }) => ({ type: "library", name, version, purl, "bom-ref": purl }));
  return { bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components };
}

export function checksums(assets) {
  if (assets.length === 0) throw new Error("Incomplete: no assets to sum.");
  return assets
    .map((asset) => `${createHash("sha256").update(readFileSync(asset)).digest("hex")}  ${basename(asset)}\n`)
    .join("");
}

function main() {
  const [out, ...assets] = process.argv.slice(2);
  if (!out) throw new Error("Usage: release-evidence.mjs <out-dir> <asset>...");
  const read = (file) => readFileSync(join(root, file), "utf8");
  const sources = [
    { file: "Cargo.lock", packages: cargoPackages(read("Cargo.lock")) },
    { file: "desktop/src-tauri/Cargo.lock", packages: cargoPackages(read("desktop/src-tauri/Cargo.lock")) },
    { file: "web/package-lock.json", packages: npmPackages(read("web/package-lock.json")) },
  ];
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "SHA256SUMS"), checksums(assets));
  writeFileSync(join(out, "sbom.cdx.json"), `${JSON.stringify(inventory(sources), null, 2)}\n`);
  console.log(`Summed ${assets.length} assets and listed ${sources.map((s) => `${s.packages.length} from ${s.file}`).join(", ")}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
