import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkUsage, plantHistory } from "./smoke-app-usage.mjs";

const engine = (id, status, files, input, output) => ({
  engine: id,
  status,
  files_scanned: files,
  files_skipped: 0,
  models: input ? [{ model: "smoke-model", input_tokens: input, output_tokens: output }] : [],
  days: [],
});

const usage = (claude, codex = engine("codex", "no_history", 0)) => ({
  status: 200,
  body: { host_id: "h", scanned_at: "2026-11-06T00:00:00Z", engines: [claude, codex] },
});

/** A synthetic service whose replies follow the planted history. */
function service(overrides = {}) {
  let grown = false;
  const routes = {
    "GET /api/usage": () => usage(engine("claude", "scanned", 2, 5100, 510)),
    "GET /api/usage?days=7": () => usage(engine("claude", "scanned", 2, 100, 10)),
    "POST /api/usage/refresh?days=7": () => usage(engine("claude", "scanned", 2, grown ? 140 : 100, grown ? 14 : 10)),
    ...overrides,
  };
  const api = async (method, path) => {
    const reply = routes[`${method} ${path}`];
    if (!reply) throw new Error(`unexpected ${method} ${path}`);
    return reply();
  };
  return { api, history: { grow: () => { grown = true; } } };
}

test("the planted history is two files, one outside a week", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbyn-usage-smoke-"));
  try {
    const history = plantHistory(dir, new Date("2026-11-06T12:00:00Z"));
    const folder = join(dir, "projects", "smoke");
    assert.deepEqual(readdirSync(folder).sort(), ["old.jsonl", "today.jsonl"]);
    history.grow();
    const lines = readFileSync(join(folder, "today.jsonl"), "utf8").trim().split("\n").map((text) => JSON.parse(text));
    assert.deepEqual(lines.map((entry) => entry.message.id), ["today-1", "today-2"]);
    assert.equal(lines[0].timestamp, "2026-11-06T12:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan status, the period and a refresh are all read back", async () => {
  const { api, history } = service();
  const observed = await checkUsage(api, history);
  assert.deepEqual(observed.claude, { files: 2, skipped: 0, all: 5610, week: 110, refreshed: 154 });
  assert.equal(observed.codex, "no_history");
});

test("a refresh that keeps the old figures fails", async () => {
  const { api } = service();
  await assert.rejects(checkUsage(api, { grow() {} }), /counted 110 Claude tokens, not 154/);
});

test("a period that keeps old history fails", async () => {
  const { api, history } = service({ "GET /api/usage?days=7": () => usage(engine("claude", "scanned", 2, 5100, 510)) });
  await assert.rejects(checkUsage(api, history), /days=7 counted 5610/);
});

test("an unreadable file fails", async () => {
  const skipped = { ...engine("claude", "scanned", 2, 5100, 510), files_skipped: 1 };
  const { api, history } = service({ "GET /api/usage": () => usage(skipped) });
  await assert.rejects(checkUsage(api, history), /could not read 1 Claude files/);
});

test("an engine with no history shown as zeros fails", async () => {
  const { api, history } = service({ "GET /api/usage": () => usage(engine("claude", "scanned", 2, 5100, 510), engine("codex", "scanned", 0)) });
  await assert.rejects(checkUsage(api, history), /Codex is scanned, not no_history/);
});
