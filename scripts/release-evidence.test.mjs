import assert from "node:assert/strict";
import { test } from "node:test";
import { cargoPackages, inventory, npmPackages } from "./release-evidence.mjs";

test("a lockfile's packages are read, workspace members left out", () => {
  const cargo = cargoPackages(`
[[package]]
name = "orbynd"
version = "0.1.0"

[[package]]
name = "serde"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`);
  assert.deepEqual(cargo.map((entry) => entry.purl), ["pkg:cargo/serde@1.0.0"]);
  const npm = npmPackages(
    JSON.stringify({ packages: { "": { version: "1" }, "node_modules/@a/b": { version: "2.0.0" } } }),
  );
  assert.deepEqual(npm.map((entry) => entry.name), ["@a/b"]);
  assert.equal(npm[0].purl, "pkg:npm/%40a/b@2.0.0");
});

test("an empty source fails instead of reading as clean", () => {
  assert.throws(() => inventory([{ file: "web/package-lock.json", packages: [] }]), /Incomplete/);
  const bom = inventory([{ file: "x", packages: [{ name: "a", version: "1", purl: "pkg:npm/a@1" }] }]);
  assert.equal(bom.components.length, 1);
});
