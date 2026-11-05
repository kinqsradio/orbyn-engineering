// Provider checks for the installed app's own service. They read status, refresh
// and model discovery, and ask for feedback only from an engine that is absent,
// so nothing is ever sent to a provider and no turn is started.

const BUILT_IN = ["claude", "codex"];

function fail(message) {
  throw new Error(`Provider check: ${message}`);
}

function engines(reply, path) {
  if (reply.status !== 200) fail(`${path} answered ${reply.status}.`);
  if (!Array.isArray(reply.body)) fail(`${path} did not list engines.`);
  const byId = new Map(reply.body.map((engine) => [engine.id, engine]));
  for (const id of BUILT_IN) {
    if (!byId.has(id)) fail(`${path} has no ${id} engine.`);
  }
  return byId;
}

function expectAbsent(engine, path) {
  if (engine.installed) fail(`${path} says ${engine.id} is installed at ${engine.path}.`);
  if (engine.updating) fail(`${path} says ${engine.id} is updating.`);
  if (engine.auth === "logged_in") fail(`${path} says the absent ${engine.id} is signed in.`);
}

function expectSignedOut(engine, path) {
  if (!engine.installed) fail(`${path} did not find the signed-out ${engine.id}: ${engine.problem ?? "no problem reported"}.`);
  if (engine.auth !== "logged_out") fail(`${path} reports ${engine.id} auth as ${engine.auth}, not logged_out.`);
  if (engine.updating) fail(`${path} says ${engine.id} is updating.`);
}

/**
 * Checks discovery, refresh, model listing and feedback through `api(method, path, body)`,
 * which resolves to `{ status, body }`. `codex` is `"absent"` or `"signed-out"`.
 * Returns what was observed, for the job log.
 */
export async function checkProviders(api, { codex = "absent" } = {}) {
  if (codex !== "absent" && codex !== "signed-out") fail(`unknown Codex expectation ${codex}.`);
  const codexCheck = codex === "absent" ? expectAbsent : expectSignedOut;
  const observed = {};

  const listed = engines(await api("GET", "/api/engines"), "GET /api/engines");
  expectAbsent(listed.get("claude"), "GET /api/engines");
  codexCheck(listed.get("codex"), "GET /api/engines");

  const refreshed = engines(await api("POST", "/api/engines/refresh"), "POST /api/engines/refresh");
  expectAbsent(refreshed.get("claude"), "POST /api/engines/refresh");
  codexCheck(refreshed.get("codex"), "POST /api/engines/refresh");
  observed.engines = BUILT_IN.map((id) => {
    const { installed, auth, version, problem } = refreshed.get(id);
    return { id, installed, auth, version: version ?? null, problem: problem ?? null };
  });

  const modelsPath = "/api/engines/codex/models?refresh=true";
  const models = await api("GET", modelsPath);
  if (models.status !== 200) fail(`${modelsPath} answered ${models.status}.`);
  const count = Array.isArray(models.body?.models) ? models.body.models.length : -1;
  if (count < 0) fail(`${modelsPath} returned no model list.`);
  if (codex === "absent") {
    // A missing engine is reported, never answered by a hidden list.
    if (!models.body.error && !models.body.fallback && count > 0) {
      fail(`${modelsPath} listed ${count} models for an absent engine with no error.`);
    }
  } else {
    if (models.body.source !== "engine") fail(`${modelsPath} came from ${models.body.source}, not the engine.`);
    if (models.body.fallback) fail(`${modelsPath} is a fallback list.`);
    if (count === 0) fail(`${modelsPath} listed no models: ${models.body.error ?? "no error"}.`);
  }
  observed.codexModels = { source: models.body.source, count, error: models.body.error ?? null };

  if (codex === "absent") {
    // Only an absent engine is asked: a present one would upload a report.
    const feedbackPath = "/api/engines/codex/feedback";
    const feedback = await api("POST", feedbackPath, { reason: "packaged smoke", include_logs: false });
    if (feedback.status >= 200 && feedback.status < 300) {
      fail(`${feedbackPath} accepted a report with no engine: ${JSON.stringify(feedback.body)}.`);
    }
    // 502 is Core's "engine unavailable"; anything else is a different failure.
    if (feedback.status !== 502) {
      fail(`${feedbackPath} failed with ${feedback.status} instead of reporting the engine unavailable.`);
    }
    observed.feedback = { status: feedback.status, body: feedback.body };
  } else {
    observed.feedback = "not sent: a signed-out engine could still upload a report";
  }
  return observed;
}
