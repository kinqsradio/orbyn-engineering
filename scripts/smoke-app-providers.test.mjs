import assert from "node:assert/strict";
import test from "node:test";
import { checkProviders } from "./smoke-app-providers.mjs";

const absent = (id) => ({ id, installed: false, auth: "unknown", path: null, version: null, updating: false, problem: null });
const signedOut = { id: "codex", installed: true, auth: "logged_out", path: "/synthetic/codex", version: "0.0.0", updating: false, problem: null };

/** A synthetic service: routes map `METHOD path` to `{ status, body }`. */
function service(routes) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const reply = routes[`${method} ${path}`];
    if (!reply) throw new Error(`unexpected ${method} ${path}`);
    return typeof reply === "function" ? reply(body) : reply;
  };
  return { api, calls };
}

const absentRoutes = (overrides = {}) => ({
  "GET /api/engines": { status: 200, body: [absent("claude"), absent("codex")] },
  "POST /api/engines/refresh": { status: 200, body: [absent("claude"), absent("codex")] },
  "GET /api/engines/codex/models?refresh=true": { status: 200, body: { engine: "codex", source: "none", models: [], error: "not installed" } },
  "POST /api/engines/codex/feedback": { status: 502, body: { code: "engine_unavailable", message: "codex was not found on this machine." } },
  ...overrides,
});

test("absent providers are listed, refreshed and refuse feedback", async () => {
  const { api, calls } = service(absentRoutes());
  const observed = await checkProviders(api);
  assert.deepEqual(observed.engines.map((engine) => engine.installed), [false, false]);
  assert.equal(observed.feedback.status, 502);
  assert.deepEqual(calls.at(-1).body, { reason: "packaged smoke", include_logs: false });
});

test("a missing built-in engine fails the check", async () => {
  const { api } = service(absentRoutes({ "GET /api/engines": { status: 200, body: [absent("codex")] } }));
  await assert.rejects(checkProviders(api), /no claude engine/);
});

test("an absent engine that reports itself installed fails", async () => {
  const installed = { ...absent("claude"), installed: true, path: "/host/claude" };
  const { api } = service(absentRoutes({ "POST /api/engines/refresh": { status: 200, body: [installed, absent("codex")] } }));
  await assert.rejects(checkProviders(api), /claude is installed/);
});

test("feedback accepted with no engine fails", async () => {
  const { api } = service(absentRoutes({ "POST /api/engines/codex/feedback": { status: 200, body: { thread_id: "x" } } }));
  await assert.rejects(checkProviders(api), /accepted a report/);
});

test("feedback that crashes the service fails instead of counting as a refusal", async () => {
  const { api } = service(absentRoutes({ "POST /api/engines/codex/feedback": { status: 500, body: {} } }));
  await assert.rejects(checkProviders(api), /failed with 500/);
});

test("feedback refused for another reason does not count as the engine being absent", async () => {
  const { api } = service(absentRoutes({ "POST /api/engines/codex/feedback": { status: 422, body: {} } }));
  await assert.rejects(checkProviders(api), /failed with 422/);
});

test("an absent engine answered by a silent model list fails", async () => {
  const listed = { status: 200, body: { engine: "codex", source: "engine", models: [{ id: "m" }], error: null } };
  const { api } = service(absentRoutes({ "GET /api/engines/codex/models?refresh=true": listed }));
  await assert.rejects(checkProviders(api), /absent engine with no error/);
});

const signedOutRoutes = (overrides = {}) => ({
  "GET /api/engines": { status: 200, body: [absent("claude"), signedOut] },
  "POST /api/engines/refresh": { status: 200, body: [absent("claude"), signedOut] },
  "GET /api/engines/codex/models?refresh=true": { status: 200, body: { engine: "codex", source: "engine", models: [{ id: "a" }, { id: "b" }], error: null } },
  ...overrides,
});

test("a signed-out Codex lists its own models and is never asked for feedback", async () => {
  const { api, calls } = service(signedOutRoutes());
  const observed = await checkProviders(api, { codex: "signed-out" });
  assert.equal(observed.codexModels.count, 2);
  assert.equal(calls.some((call) => call.path.includes("feedback")), false);
});

test("a signed-out Codex reported as signed in fails", async () => {
  const signedIn = { ...signedOut, auth: "logged_in" };
  const { api } = service(signedOutRoutes({ "GET /api/engines": { status: 200, body: [absent("claude"), signedIn] } }));
  await assert.rejects(checkProviders(api, { codex: "signed-out" }), /not logged_out/);
});

test("a signed-out Codex answered by a fallback list fails", async () => {
  const fallback = { status: 200, body: { engine: "codex", source: "engine", models: [{ id: "a" }], fallback: true } };
  const { api } = service(signedOutRoutes({ "GET /api/engines/codex/models?refresh=true": fallback }));
  await assert.rejects(checkProviders(api, { codex: "signed-out" }), /fallback/);
});

test("an unknown expectation is refused", async () => {
  await assert.rejects(checkProviders(async () => ({}), { codex: "signed-in" }), /unknown Codex expectation/);
});
