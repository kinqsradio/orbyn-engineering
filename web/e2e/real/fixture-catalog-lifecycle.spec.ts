//! Controlled ACP catalog ownership; never invokes an installed provider.
import { expect, test } from "@playwright/test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { startService } from "./service";

/** The same .cjs entrypoint, through launchers Core can resolve on either platform. */
function controlledProvider(control: string, source: string) {
  const script = join(control, "opencode.cjs");
  writeFileSync(script, source);
  if (process.platform === "win32") {
    // Core follows the npm-style relative script path instead of executing cmd.exe.
    const node = process.execPath.replace(/%/g, "%%");
    writeFileSync(join(control, "opencode.cmd"), `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${node}" "%~dp0\\opencode.cjs" %*\r\n`);
  } else {
    const quote = (path: string) => "'" + path.replace(/'/g, "'\\''") + "'";
    writeFileSync(join(control, "opencode"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  }
}

function providerPath(control: string, original: string | undefined) {
  return [control, dirname(process.execPath), ...(original ? [original] : [])].join(delimiter);
}

function restorePath(original: string | undefined) {
  if (original === undefined) delete process.env.PATH;
  else process.env.PATH = original;
}

test("stopping a fixture terminates its pending controlled ACP catalog writer", async ({ page }, info) => {
  const control = mkdtempSync(join(tmpdir(), "orbyn-catalog-owner-"));
  const events = join(control, "events.jsonl");
  writeFileSync(events, "");
  await page.goto("about:blank");
  controlledProvider(control, `const fs=require('node:fs'),path=require('node:path');
const log=${JSON.stringify(events)};
const home=process.env.HOME;
const record=(kind)=>fs.appendFileSync(log,JSON.stringify({kind,pid:process.pid,parent:process.ppid,home,time:Date.now()})+'\\n');
record('start');
require('node:readline').createInterface({input:process.stdin}).on('line',()=>record('request'));
setInterval(()=>{fs.mkdirSync(path.join(home,'.config','controlled-catalog'),{recursive:true});record('write');},20);
`);
  const original = process.env.PATH;
  process.env.PATH = providerPath(control, original);
  let service;
  try { service = await startService({ fakeEngines: true, discoverKnownEngines: true }); }
  finally { restorePath(original); }
  const abort = new AbortController();
  const pending = fetch(`${service.url}/api/engines/opencode/models`, {
    headers: { Authorization: `Bearer ${new URL(service.page).searchParams.get("token")}` }, signal: abort.signal,
  }).catch(() => null);
  const records = () => readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {kind:string;pid:number;parent:number;home:string;time:number});
  let stopAttempted = false;
  try {
    const engines = await service.api<{ id:string }[]>("GET", "/api/engines");
    expect(engines.some((engine) => engine.id === "opencode")).toBe(true);
    await expect.poll(() => records().filter((row) => row.kind === "request").length).toBeGreaterThan(0);
    const writer = records()[0]!;
    const diagnostics = await service.api<{processes:{pid:number;parent:number|null;name:string}[]}>("GET", "/api/diagnostics");
    const children = diagnostics.processes;
    expect(children.some((row) => row.pid === writer.pid)).toBe(true);
    appendFileSync(events, `${JSON.stringify({kind:"before-stop",time:Date.now(),children})}\n`);
    stopAttempted = true;
    await service.stop();
    const stopped = Date.now();
    appendFileSync(events, `${JSON.stringify({kind:"after-stop",time:stopped})}\n`);
    await expect.poll(() => {
      try { process.kill(writer.pid, 0); return true; } catch { return false; }
    }).toBe(false);
    expect(records().filter((row) => row.kind === "write" && row.time > stopped)).toEqual([]);
    expect(existsSync(writer.home)).toBe(false);
  } finally {
    if (!stopAttempted) await service.stop();
    abort.abort();
    await pending;
    await info.attach("controlled-catalog-events", {path:events,contentType:"application/jsonl"});
  }
});

test("ordinary fixtures exclude ambient known providers without launching them", async ({ page }, info) => {
  await page.goto("about:blank");
  const control = mkdtempSync(join(tmpdir(), "orbyn-catalog-exclude-"));
  const marker = join(control, "unexpected-provider-launch");
  controlledProvider(control, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched');\n`);
  const original = process.env.PATH;
  process.env.PATH = providerPath(control, original);
  let service;
  try { service = await startService({ fakeEngines: true }); }
  finally { restorePath(original); }
  try {
    const engines = await service.api<{ id: string }[]>("GET", "/api/engines");
    await info.attach("fixture-engine-ids", {body:JSON.stringify(engines.map((engine)=>engine.id)),contentType:"application/json"});
    expect(engines.some((engine) => engine.id === "opencode")).toBe(false);
    expect(engines.some((engine) => engine.id === "codex")).toBe(true);
    expect(engines.some((engine) => engine.id === "claude")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally { await service.stop(); }
});
