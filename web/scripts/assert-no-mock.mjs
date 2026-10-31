// Fails the build if anything from the dev-only mock API reached the output.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const markers = ["__mock/", "mock-fixture", "createMockApi"];
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const offenders = walk("dist")
  .filter((path) => /\.(js|css|html)$/.test(path))
  .filter((path) => {
    const text = readFileSync(path, "utf8");
    return markers.some((marker) => text.includes(marker));
  });

if (offenders.length > 0) {
  console.error(`Mock API found in production output: ${offenders.join(", ")}`);
  process.exit(1);
}
console.log("No mock API in production output.");
