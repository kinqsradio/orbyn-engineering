import { expect, test } from "@playwright/test";
import { projectSettingsUrl, startProject, type Service } from "./service";

/**
 * K1: settings the service reads per project, each bound on its page to the
 * selected checkout: a write lands on that project alone, Inherit removes it,
 * and the environment value never moves.
 */

let service: Service;
let projectId = "";

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
});
test.afterAll(() => service.stop());

type Preference = { key: string; value: unknown; source: string };
const pref = async (key: string, project?: string) =>
  (await service.api<Preference[]>("GET", project ? `/api/preferences?project_id=${project}` : "/api/preferences"))
    .find((entry) => entry.key === key);

const ROWS = [
  { section: "threads", key: "continue_threads_after_update", title: "Continue threads after an update", initial: true },
  { section: "threads", key: "enable_agent_browser_access", title: "Let agents use the browser", initial: true },
  { section: "threads", key: "auto_settle_keep_pull_requests", title: "Keep threads with open pull requests", initial: false },
];

for (const row of ROWS) {
  test(`${row.title} saves for the selected checkout and inherits again`, async ({ page }) => {
    const environment = await pref(row.key);
    expect(environment?.value).toBe(row.initial);
    await page.goto(await projectSettingsUrl(service, projectId, row.section));
    const toggle = page.getByRole("switch", { name: row.title, exact: true });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-checked", String(row.initial));
    const saved = page.waitForResponse((response) => response.request().method() === "PUT"
      && new URL(response.url()).pathname === "/api/settings/preferences");
    await toggle.click();
    const body = (await saved).request().postDataJSON() as { scope: { selection: { kind: string; project_id?: string } }; edits: Record<string, unknown> };
    expect(body.scope.selection).toMatchObject({ kind: "checkout", project_id: projectId });
    expect(body.edits).toEqual({ [row.key]: { op: "set", value: !row.initial } });
    await expect.poll(async () => pref(row.key, projectId)).toMatchObject({ value: !row.initial, source: "project" });
    expect(await pref(row.key)).toEqual(environment);

    await page.getByRole("button", { name: `Reset ${row.title} to default`, exact: true }).click();
    await expect.poll(async () => (await pref(row.key, projectId))?.source).not.toBe("project");
    expect((await pref(row.key, projectId))?.value).toBe(row.initial);
    await expect(toggle).toHaveAttribute("aria-checked", String(row.initial));
    expect(await pref(row.key)).toEqual(environment);
  });
}

test("default access mode and show answers are set for the environment on the Chat page", async ({ page }) => {
  await page.goto(`${service.page}#/settings/chat`);
  for (const [key, title, value] of [
    ["default_permission_mode", "Default access mode", "auto"],
    ["response_streaming_mode", "Show answers", "turn"],
  ] as const) {
    const before = (await pref(key))?.value;
    const select = page.getByRole("combobox", { name: title, exact: true });
    await expect(select).toBeEnabled();
    await select.selectOption(value);
    await expect.poll(async () => (await pref(key))?.value).toBe(value);
    await page.getByRole("button", { name: `Reset ${title} to default`, exact: true }).click();
    await expect.poll(async () => (await pref(key))?.value).toBe(before);
  }
  // A new thread takes the environment's default access mode.
  await page.getByRole("combobox", { name: "Default access mode", exact: true }).selectOption("auto_edits");
  await expect.poll(async () => (await pref("default_permission_mode"))?.value).toBe("auto_edits");
  const thread = await service.api<{ lifecycle: { permission_mode: string } }>("POST", "/api/threads", {
    project_id: projectId, engine: "codex", model: null, title: "Scoped mode", worktree: null, skill_profile: null,
  });
  expect(thread.lifecycle.permission_mode).toBe("auto_edits");
});

test("a provider turned off for one project is refused there and inherits again", async ({ page }) => {
  const engines = await service.api<{ id: string; name: string }[]>("GET", "/api/engines");
  const codex = engines.find((engine) => engine.id === "codex")!;
  await page.goto(await projectSettingsUrl(service, projectId, "providers"));
  await expect(page.getByRole("table", { name: "Providers", exact: true })).toBeVisible();
  const toggle = page.getByRole("switch", { name: `Use ${codex.name}`, exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(async () => (await pref("disabled_engines", projectId))?.value).toEqual(["codex"]);
  expect((await pref("disabled_engines"))?.value).toEqual([]);
  const create = () => fetch(`${service.url}/api/threads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${new URL(service.page).searchParams.get("token")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, engine: "codex", model: null, title: "Off", worktree: null, skill_profile: null }),
  });
  const refused = await create();
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("turned off for this project");

  // The checkout view of the row has no Reset control (the popover only lists layers), so the override is cleared through the API.
  await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { disabled_engines: null } });
  await expect.poll(async () => (await pref("disabled_engines", projectId))?.source).not.toBe("project");
  // The page does not watch a change made behind its back, so it is read again before the row is judged.
  await page.reload();
  await expect(page.getByRole("table", { name: "Providers", exact: true })).toBeVisible();
  await expect(toggle).toBeChecked();
  expect((await create()).ok).toBe(true);
});
