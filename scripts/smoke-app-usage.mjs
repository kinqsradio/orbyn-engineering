// Usage checks for the installed app's own service. They plant a small Claude
// history in the private profile, then read it back the way the Usage page does:
// scan status per engine, a period filter, and fresh figures after history grows.
// Nothing here starts a turn or reads a credential.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODEL = "smoke-model";

function fail(message) {
  throw new Error(`Usage check: ${message}`);
}

function line(id, timestamp, input, output) {
  return `${JSON.stringify({ timestamp, message: { id, model: MODEL, usage: { input_tokens: input, output_tokens: output } } })}\n`;
}

/**
 * Writes two Claude history files under `claudeDir`: one with a message from today
 * and one from 2020, which a 7-day period leaves out. Returns `grow()`, which adds a
 * message to today's file the way a running engine would.
 */
export function plantHistory(claudeDir, now = new Date()) {
  const folder = join(claudeDir, "projects", "smoke");
  mkdirSync(folder, { recursive: true });
  const today = join(folder, "today.jsonl");
  writeFileSync(today, line("today-1", now.toISOString(), 100, 10));
  writeFileSync(join(folder, "old.jsonl"), line("old-1", "2020-01-01T00:00:00Z", 5000, 500));
  return {
    grow: () => appendFileSync(today, line("today-2", now.toISOString(), 40, 4)),
  };
}

function report(reply, path) {
  if (reply.status !== 200) fail(`${path} answered ${reply.status}.`);
  const engines = reply.body?.engines;
  if (!Array.isArray(engines)) fail(`${path} listed no engines.`);
  const byId = new Map(engines.map((engine) => [engine.engine, engine]));
  for (const id of ["claude", "codex"]) {
    if (!byId.has(id)) fail(`${path} has no ${id} entry.`);
  }
  return { scannedAt: reply.body.scanned_at, claude: byId.get("claude"), codex: byId.get("codex") };
}

function tokens(engine) {
  const model = engine.models.find((entry) => entry.model === MODEL);
  return model ? model.input_tokens + model.output_tokens : 0;
}

function expectScan(engine, path, files, total) {
  if (engine.status !== "scanned") fail(`${path} says Claude is ${engine.status}, not scanned.`);
  if (engine.files_scanned !== files) fail(`${path} read ${engine.files_scanned} Claude files, not ${files}.`);
  if (engine.files_skipped !== 0) fail(`${path} could not read ${engine.files_skipped} Claude files.`);
  if (tokens(engine) !== total) fail(`${path} counted ${tokens(engine)} Claude tokens, not ${total}.`);
}

/**
 * Checks the scan status, the period filter and a refresh through
 * `api(method, path, body)`, after `plantHistory`. Returns what was observed.
 */
export async function checkUsage(api, history) {
  const all = report(await api("GET", "/api/usage"), "GET /api/usage");
  expectScan(all.claude, "GET /api/usage", 2, 5610);
  // No Codex history was planted, so its row must say so rather than show zeros.
  if (all.codex.status !== "no_history") fail(`GET /api/usage says Codex is ${all.codex.status}, not no_history.`);
  if (!all.scannedAt) fail("GET /api/usage has no scan time.");

  const weekPath = "/api/usage?days=7";
  const week = report(await api("GET", weekPath), weekPath);
  expectScan(week.claude, weekPath, 2, 110);

  history.grow();
  const refreshPath = "/api/usage/refresh?days=7";
  const refreshed = report(await api("POST", refreshPath), refreshPath);
  expectScan(refreshed.claude, refreshPath, 2, 154);
  if (Date.parse(refreshed.scannedAt) < Date.parse(week.scannedAt)) {
    fail(`${refreshPath} scanned at ${refreshed.scannedAt}, before ${week.scannedAt}.`);
  }

  return {
    claude: { files: refreshed.claude.files_scanned, skipped: refreshed.claude.files_skipped, all: tokens(all.claude), week: tokens(week.claude), refreshed: tokens(refreshed.claude) },
    codex: all.codex.status,
    scannedAt: refreshed.scannedAt,
  };
}
