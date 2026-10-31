// Installs the built package, starts it with a private profile and no secrets, and
// checks what only a real launch shows: the shell starts the service, the UI runs in
// the window, a second launch hands over and exits, and the service ends with the app.
// Usage: node scripts/smoke-app.mjs [bundle-root]
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const START_LIMIT_MS = 90_000;
const STAY_ALIVE_MS = 10_000;
const HANDOFF_LIMIT_MS = 30_000;
const STOP_LIMIT_MS = 20_000;

// Real path: Tauri refuses to find its resources through a symlink, and macOS's
// temp folder is reached through one.
const sandbox = mkdtempSync(join(realpathSync(tmpdir()), "orbyn-app-smoke-"));
const home = join(sandbox, "home");
const data = join(sandbox, "data");
for (const dir of [home, data, join(home, "AppData/Local"), join(home, "AppData/Roaming")]) {
  mkdirSync(dir, { recursive: true });
}

/** Names copied from this process; everything else, secrets included, stays behind. */
const KEPT = ["PATH", "Path", "SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG"];

const environment = {
  ...Object.fromEntries(KEPT.filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
  HOME: home,
  CFFIXED_USER_HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: join(home, "AppData/Local"),
  APPDATA: join(home, "AppData/Roaming"),
  ORBYN_DATA_DIR: data,
  ORBYN_OFFLINE: "1",
};

function find(folder, test) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(test).map((name) => join(folder, name));
}

function bundleRoot() {
  const candidates = [
    process.argv[2],
    process.env.CARGO_TARGET_DIR && join(process.env.CARGO_TARGET_DIR, "release/bundle"),
    join(root, "desktop/src-tauri/target/release/bundle"),
  ].filter(Boolean);
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`No bundle in ${candidates.join(", ")}`);
  return found;
}

/** The app's executable after a real install into the sandbox. */
function install() {
  const bundles = bundleRoot();
  const installed = join(sandbox, "installed");
  if (windows) {
    const [setup] = find(join(bundles, "nsis"), (name) => name.endsWith("-setup.exe"));
    if (!setup) throw new Error("No NSIS installer was built.");
    // NSIS wants /D last and unquoted, so the line goes through as one string.
    execFileSync(`"${setup}" /S /D=${installed}`, { shell: true, stdio: "inherit", env: environment });
    const apps = find(installed, (name) => /\.exe$/i.test(name) && !/^(uninstall|orbynd|orbyn)\.exe$/i.test(name));
    if (apps.length !== 1) throw new Error(`Expected one app, found: ${apps.join(", ")}`);
    return apps[0];
  }
  const [bundle] = find(join(bundles, "macos"), (name) => name.endsWith(".app"));
  if (!bundle) throw new Error("No app bundle was built.");
  mkdirSync(installed);
  const app = join(installed, "Orbyn Engineering.app");
  cpSync(bundle, app, { recursive: true, verbatimSymlinks: true });
  const [exe] = find(join(app, "Contents/MacOS"), (name) => !/^orbynd?$/.test(name));
  if (!exe) throw new Error("The bundle has no app executable.");
  return exe;
}

async function until(limit, what, check) {
  const end = Date.now() + limit;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > end) throw new Error(`Timed out: ${what}.`);
    await delay(250);
  }
}

function launch(exe, args = []) {
  const child = spawn(exe, args, { env: environment, stdio: ["ignore", "ignore", "pipe"] });
  child.exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  child.running = true;
  child.exited.then(() => {
    child.running = false;
  });
  let tail = "";
  child.stderr.on("data", (chunk) => {
    tail = (tail + chunk).slice(-4000);
  });
  child.tail = () => tail;
  return child;
}

/** Ends the app alone, or with `tree` everything it started. */
function stop(child, tree = false) {
  if (!child.running) return;
  const scope = tree ? ["/T"] : [];
  if (windows) execFileSync("taskkill", ["/PID", String(child.pid), ...scope, "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

async function main() {
  const exe = install();
  console.log("Installed:", exe);
  const app = launch(exe);
  try {
    const handle = join(data, "service.json");
    const service = await until(START_LIMIT_MS, "the app never started its service", () => {
      if (!app.running) throw new Error(`The app exited during startup.\n${app.tail()}`);
      return existsSync(handle) ? JSON.parse(readFileSync(handle, "utf8")) : null;
    });
    const get = async (path) => {
      const response = await fetch(new URL(path, service.url), {
        headers: { Authorization: `Bearer ${service.token}` },
      });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    };
    console.log("Service:", await get("/api/info"));
    await until(START_LIMIT_MS, "the UI never ran in the window", async () => {
      if (!app.running) throw new Error(`The app exited after startup.\n${app.tail()}`);
      const shell = await get("/api/shell");
      if (!shell.attached) throw new Error("The service has no shell.");
      return shell.windows > 0;
    });
    console.log("The UI is running in the window.");

    await delay(STAY_ALIVE_MS);
    if (!app.running) throw new Error(`The app died after starting.\n${app.tail()}`);
    await get("/api/info");

    const second = launch(exe, ["orbyn://usage"]);
    const outcome = await Promise.race([second.exited, delay(HANDOFF_LIMIT_MS)]);
    if (!outcome) {
      stop(second, true);
      throw new Error("A second launch did not hand over and exit.");
    }
    if (!app.running) throw new Error("The first app died when the second launched.");
    console.log("A second launch handed over:", outcome);

    stop(app);
    await until(STOP_LIMIT_MS, "the service outlived the app", () => !existsSync(handle));
    console.log("The service ended with the app.");
  } finally {
    stop(app, true);
    await Promise.race([app.exited, delay(5000)]);
  }
}

try {
  await main();
  console.log("App smoke passed.");
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
