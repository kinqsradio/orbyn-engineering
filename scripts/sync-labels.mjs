// Creates or updates the repository labels from .github/labels.json. Labels that
// are not in the file are left alone. Needs the GitHub CLI, signed in with write
// access to the repository.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const labels = JSON.parse(readFileSync(join(root, ".github/labels.json"), "utf8"));
const repo = process.argv[2] ?? "orbyn-dev/orbyn-engineering";

for (const { name, color, description } of labels) {
  execFileSync(
    "gh",
    ["label", "create", name, "--repo", repo, "--color", color, "--description", description, "--force"],
    { stdio: "inherit" },
  );
}
console.log(`${labels.length} labels synced to ${repo}.`);
