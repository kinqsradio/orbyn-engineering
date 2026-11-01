//! Selected project names through real orbynd. All paths and Git data are disposable.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../src/generated/Project";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import { startProject, type Service } from "./service";

const renamePath = "/api/settings/projects/rename";
const nameField = (page: Page) => page.getByRole("textbox", { name: "Project name", exact: true });
const catalog = (service: Service) => service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
const projects = (service: Service) => service.api<Project[]>("GET", "/api/projects");
async function checkout(service: Service, name: string) {
  const row = await service.api<Project>("POST", "/api/projects/create", { name, readme: true });
  execFileSync("git", ["-C", row.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Owner/Details.git"], { stdio: "ignore" });
  return row;
}
async function fixture(fakeEngines = false) {
  const { service, projectId: unrelatedId } = await startProject({ fakeEngines });
  const one = await checkout(service, "detail-one");
  const two = await checkout(service, "detail-two");
  await service.api("POST", `/api/projects/${one.id}/trust`);
  for (const project of [one, two]) writeFileSync(join(project.path, "keep-local.txt"), "unchanged local work");
  const initial = await projects(service);
  const read = await catalog(service);
  const group = read.groups.find((entry) => entry.members.some((member) => member.project_id === one.id));
  const unrelated = read.groups.find((entry) => entry.members.some((member) => member.project_id === unrelatedId));
  if (!group || group.members.length !== 2 || !unrelated) throw new Error("fixture requires two grouped checkouts and an unrelated project");
  return { service, one, two, unrelatedId, initial, group, unrelated,
    url: `${service.page}#/settings/projects?project=${encodeURIComponent(group.key)}` };
}
function mutations(page: Page) {
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === renamePath) requests.push(request.postDataJSON() as Record<string, unknown>);
  });
  return requests;
}
const projectNames = async (service: Service) => Object.fromEntries((await projects(service)).map((row) => [row.id, row.name]));

test("selected project names update the group or checkout without changing paths and trust", async ({ page }, info) => {
  const { service, one, two, unrelatedId, initial, group, url } = await fixture();
  const writes = mutations(page);
  try {
    await page.goto(`${service.page}#/settings/projects`);
    await expect(page.getByText("Choose a project to manage its name, icon, checkouts and actions.", { exact: true })).toBeVisible();
    await expect(nameField(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(0);
    await page.goto(`${service.page}#/settings/projects?project=missing-project`);
    await expect(page.getByRole("button", { name: "Project scope: Unavailable project", exact: true })).toBeVisible();
    await expect(nameField(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add action", exact: true })).toHaveCount(0);
    await page.goto(url);
    await expect(nameField(page)).toHaveValue(group.label);
    await expect(nameField(page)).not.toHaveAttribute("maxlength");
    await nameField(page).focus(); await nameField(page).blur();
    await nameField(page).fill("discarded edit"); await nameField(page).fill(group.label); await nameField(page).blur();
    expect(writes).toEqual([]);
    await nameField(page).fill("Composing title");
    await nameField(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(nameField(page)).toBeFocused();
    await nameField(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", repeat: true });
    await expect(nameField(page)).toBeFocused();
    expect(writes).toEqual([]);
    await nameField(page).fill(group.label); await nameField(page).blur();
    await nameField(page).fill("   "); await nameField(page).blur();
    await expect(page.getByText("Project title cannot be empty", { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await nameField(page).fill("  Shared detail name  "); await nameField(page).press("Enter");
    await expect.poll(() => projectNames(service)).toMatchObject({ [one.id]: "Shared detail name", [two.id]: "Shared detail name" });
    await expect(nameField(page)).toHaveValue("Shared detail name");
    await expect(nameField(page)).toBeEnabled();
    expect(writes).toEqual([expect.objectContaining({ scope: { selection: { kind: "project_group", group_key: group.key } },
      membership_version: expect.any(String), expected_names: { [one.id]: one.name, [two.id]: two.name }, name: "Shared detail name" })]);
    await expect(page.getByRole("link", { name: "New thread in Shared detail name", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review trust for Shared detail name", exact: true })).toBeVisible();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings.getByText("Git root", { exact: true })).toHaveCount(0);
    await expect(settings.getByText("Revision", { exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: /^Settings for / })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "Trust folder", exact: true })).toHaveCount(0);
    await expect(settings.getByRole("combobox", { name: "Default workspace", exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Add action", exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("selected-project-detail.png") });
    await page.goto(`${url}&checkout=${encodeURIComponent(one.id)}`);
    await expect(nameField(page)).toHaveValue("Shared detail name");
    const longName = "名😀".repeat(70);
    await nameField(page).fill(`\uFEFF${longName}\uFEFF`); await nameField(page).press("Enter");
    await expect.poll(() => projectNames(service)).toMatchObject({ [one.id]: longName, [two.id]: "Shared detail name" });
    await expect(nameField(page)).toBeEnabled();
    const freshGroup = (await catalog(service)).groups.find((entry) => entry.key === group.key)!;
    await expect(nameField(page)).toHaveValue(freshGroup.label); // Checkout still displays its original logical group's label.
    expect(writes[1]).toMatchObject({ scope: { selection: { kind: "checkout", group_key: group.key, project_id: one.id } }, expected_names: { [one.id]: "Shared detail name" }, name: longName });
    const after = await projects(service);
    for (const before of initial) expect(after.find((row) => row.id === before.id)).toMatchObject({ path: before.path, trusted: before.trusted });
    expect(after.find((row) => row.id === unrelatedId)?.name).toBe(initial.find((row) => row.id === unrelatedId)?.name);
    for (const row of [one, two]) {
      expect(existsSync(row.path)).toBe(true);
      expect(readFileSync(join(row.path, "keep-local.txt"), "utf8")).toBe("unchanged local work");
    }
  } finally { await service.stop(); }
});

test("a conflicting name retains its draft and a saved name survives a failed scope refresh", async ({ page }) => {
  const { service, one, two, group, url } = await fixture();
  const writes = mutations(page);
  let failRead = false;
  await page.route("**/api/settings/project-scopes", async (route) => {
    if (!failRead) { await route.continue(); return; }
    await route.fulfill({ status: 503, json: { code: "fixture_read_unavailable", message: "Fixture scope refresh unavailable." } });
  });
  try {
    await page.goto(url);
    await expect(nameField(page)).toHaveValue(group.label);
    await nameField(page).fill("Retained name draft");
    await service.api("PATCH", `/api/projects/${one.id}`, { name: "External checkout name" });
    const conflict = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === renamePath);
    await nameField(page).blur();
    expect((await conflict).status()).toBe(409);
    await expect(nameField(page)).toHaveValue("Retained name draft");
    await expect(nameField(page)).toBeEnabled();
    expect(writes).toHaveLength(1);
    expect(await projectNames(service)).toMatchObject({ [one.id]: "External checkout name", [two.id]: two.name });
    await nameField(page).focus(); await nameField(page).press("Enter");
    await expect.poll(() => projectNames(service)).toMatchObject({ [one.id]: "Retained name draft", [two.id]: "Retained name draft" });
    await expect(nameField(page)).toBeEnabled();
    expect(writes[1]).toMatchObject({ expected_names: { [one.id]: "External checkout name", [two.id]: two.name } });
    failRead = true;
    await nameField(page).fill("Saved before refresh failure"); await nameField(page).press("Enter");
    await expect.poll(() => projectNames(service)).toMatchObject({ [one.id]: "Saved before refresh failure", [two.id]: "Saved before refresh failure" });
    await expect(page.getByRole("alert").filter({ hasText: "Fixture scope refresh unavailable." })).toBeVisible();
    await expect(nameField(page)).toHaveValue("Saved before refresh failure");
    await expect(nameField(page)).toBeDisabled();
    expect(writes).toHaveLength(3);
    failRead = false;
    await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Retry", exact: true }).click();
    await expect(nameField(page)).toBeEnabled();
    await expect(nameField(page)).toHaveValue("Saved before refresh failure");
    expect(writes).toHaveLength(3); // Retry reads; it never resubmits the committed rename.
  } finally { await service.stop(); }
});

test("a delayed group rename cannot replace another selection's draft", async ({ page }) => {
  const { service, one, two, group, unrelated, unrelatedId, url } = await fixture();
  let release = () => {};
  let committed = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const written = new Promise<void>((resolve) => { committed = resolve; });
  let first = true;
  const oldResponse = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === renamePath);
  await page.route(`**${renamePath}`, async (route) => {
    if (!first) { await route.continue(); return; }
    first = false;
    const response = await route.fetch();
    committed(); await held; await route.fulfill({ response });
  });
  try {
    await page.goto(url);
    await nameField(page).fill("Committed group name"); await nameField(page).blur();
    await written;
    expect(await projectNames(service)).toMatchObject({ [one.id]: "Committed group name", [two.id]: "Committed group name" });
    await page.getByRole("button", { name: `Project scope: ${group.label}`, exact: true }).click();
    await page.getByRole("menuitemradio", { name: unrelated.label, exact: true }).click();
    await expect(nameField(page)).toHaveValue(unrelated.label);
    await nameField(page).fill("New selection draft");
    release(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(nameField(page)).toHaveValue("New selection draft");
    expect((await projectNames(service))[unrelatedId]).toBe(unrelated.members[0]!.name);
    await nameField(page).press("Enter");
    await expect.poll(() => projectNames(service)).toMatchObject({ [unrelatedId]: "New selection draft", [one.id]: "Committed group name", [two.id]: "Committed group name" });
  } finally { release(); await service.stop(); }
});

test("changed group membership conflicts and rebases only on an explicit retry", async ({ page }) => {
  const { service, one, two, group, unrelatedId, initial, url } = await fixture();
  const writes = mutations(page);
  try {
    await page.goto(url);
    await expect(nameField(page)).toHaveValue(group.label);
    await nameField(page).fill("Expanded group name");
    const third = await checkout(service, "detail-three");
    const conflict = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === renamePath);
    await nameField(page).blur(); expect((await conflict).status()).toBe(409);
    await expect(nameField(page)).toHaveValue("Expanded group name");
    await expect(nameField(page)).toBeEnabled();
    expect(writes).toHaveLength(1);
    await nameField(page).focus(); await nameField(page).press("Enter");
    await expect.poll(() => projectNames(service)).toMatchObject({ [one.id]: "Expanded group name", [two.id]: "Expanded group name", [third.id]: "Expanded group name" });
    expect(writes[1]).toMatchObject({ expected_names: { [one.id]: one.name, [two.id]: two.name, [third.id]: third.name } });
    expect((await projectNames(service))[unrelatedId]).toBe(initial.find((row) => row.id === unrelatedId)?.name);
  } finally { await service.stop(); }
});


const removalDialog = (page: Page) => page.getByRole("dialog", { name: /^Remove (project|checkout) / });
function deletions(page: Page) {
  const requests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "DELETE" && url.pathname.startsWith("/api/projects/")) requests.push(url);
  });
  return requests;
}
async function makeThread(service: Service, projectId: string, title: string, archived = false) {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title });
  if (archived) await service.api("PATCH", `/api/threads/${thread.id}`, { archived: true });
  return thread.id;
}
const threadRows = (service: Service, projectId: string, archived = false) =>
  service.api<{ id: string }[]>("GET", `/api/threads?project_id=${projectId}&archived=${archived}`);

test("registered checkout removal counts archived threads, cancels without writes and keeps peers and files", async ({ page }, info) => {
  const { service, one, two, unrelatedId, url } = await fixture();
  const deletes = deletions(page);
  try {
    await makeThread(service, one.id, "Current checkout thread");
    await makeThread(service, one.id, "Archived checkout thread", true);
    const peerThread = await makeThread(service, two.id, "Peer remains");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Checkouts", exact: true })).toBeVisible();
    await page.getByRole("button", { name: `Remove checkout ${one.path}`, exact: true }).click();
    const dialog = removalDialog(page);
    await expect(dialog).toHaveAccessibleName(`Remove checkout "${one.name}" and delete its 2 threads?`);
    await expect(dialog.getByText(`Path: ${one.path}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText("Other entries in this grouped project are unaffected.", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/archived threads are deleted/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(deletes).toEqual([]);
    expect((await projects(service)).some((entry) => entry.id === one.id)).toBe(true);
    expect(await threadRows(service, one.id, true)).toHaveLength(1);
    await page.getByRole("button", { name: `Remove checkout ${one.path}`, exact: true }).click();
    await removalDialog(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(removalDialog(page)).toHaveCount(0);
    await expect.poll(() => projects(service)).not.toContainEqual(expect.objectContaining({ id: one.id }));
    expect((await projects(service)).map((entry) => entry.id)).toEqual(expect.arrayContaining([two.id, unrelatedId]));
    expect(await threadRows(service, one.id)).toEqual([]);
    expect(await threadRows(service, one.id, true)).toEqual([]);
    expect(await threadRows(service, two.id)).toContainEqual(expect.objectContaining({ id: peerThread }));
    await expect(nameField(page)).toHaveValue(two.name);
    await expect(page.getByRole("heading", { name: "Checkouts", exact: true })).toHaveCount(0);
    expect(deletes.map((request) => request.pathname)).toEqual([`/api/projects/${one.id}`]);
    expect(deletes[0]!.search).toBe(""); // Existing file-preserving DELETE; no delete_files or force escalation.
    for (const row of [one, two]) expect(readFileSync(join(row.path, "keep-local.txt"), "utf8")).toBe("unchanged local work");
    await page.screenshot({ path: info.outputPath("registered-checkout-removed.png") });
  } finally { await service.stop(); }
});

test("whole project removal clears selection only after the confirmed entries are gone", async ({ page }) => {
  const { service, one, two, unrelatedId, group, url } = await fixture();
  const deletes = deletions(page);
  try {
    await makeThread(service, one.id, "First entry thread");
    await makeThread(service, two.id, "Second archived entry", true);
    await page.goto(url);
    await page.getByRole("button", { name: "Remove all entries", exact: true }).click();
    const dialog = removalDialog(page);
    await expect(dialog).toHaveAccessibleName(`Remove project "${group.label}" and delete its 2 threads?`);
    await expect(dialog.getByText("This removes 2 grouped project entries.", { exact: true })).toBeVisible();
    await expect(dialog.getByText("This removes only the project entries, not the files on disk.", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/projects$/);
    await expect(page.getByText("Choose a project to manage its name, icon, checkouts and actions.", { exact: true })).toBeVisible();
    await expect(nameField(page)).toHaveCount(0);
    expect(deletes.map((request) => request.pathname).sort()).toEqual([`/api/projects/${one.id}`, `/api/projects/${two.id}`].sort());
    expect((await projects(service)).map((entry) => entry.id)).toContain(unrelatedId);
    for (const row of [one, two]) {
      expect(existsSync(row.path)).toBe(true);
      expect(readFileSync(join(row.path, "keep-local.txt"), "utf8")).toBe("unchanged local work");
    }
  } finally { await service.stop(); }
});

test("selected checkout removal never removes its peer or silently broadens the selection", async ({ page }) => {
  const { service, one, two, url } = await fixture();
  const deletes = deletions(page);
  try {
    await makeThread(service, one.id, "Selected archived thread", true);
    await makeThread(service, two.id, "Other checkout thread");
    await page.goto(`${url}&checkout=${encodeURIComponent(one.id)}`);
    await expect(nameField(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Checkouts", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Remove checkout", exact: true }).click();
    await expect(removalDialog(page)).toHaveAccessibleName(`Remove checkout "${one.name}" and delete its 1 thread?`);
    await removalDialog(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(removalDialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Project scope: Unavailable project", exact: true })).toBeVisible();
    expect(page.url()).toContain(`checkout=${encodeURIComponent(one.id)}`);
    await expect(nameField(page)).toHaveCount(0);
    expect(deletes.map((request) => request.pathname)).toEqual([`/api/projects/${one.id}`]);
    expect((await projects(service)).some((entry) => entry.id === two.id)).toBe(true);
    expect(await threadRows(service, two.id)).toHaveLength(1);
    expect(existsSync(one.path)).toBe(true);
  } finally { await service.stop(); }
});

test("a partial group removal reports its busy member and retries only the entries still present", async ({ page }) => {
  const { service, one, two, unrelatedId, url } = await fixture(true);
  const deletes = deletions(page);
  try {
    await service.api("POST", `/api/projects/${two.id}/trust`);
    const activeThread = await makeThread(service, two.id, "Busy checkout");
    const run = await service.api<{ id: string }>("POST", `/api/threads/${activeThread}/runs`, { prompt: "[hang]" });
    await expect.poll(async () => (await service.api<{ active_run: { state: string } | null }>("GET", `/api/threads/${activeThread}`)).active_run?.state).toBe("running");
    await page.goto(url);
    await page.getByRole("button", { name: "Remove all entries", exact: true }).click();
    await removalDialog(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(removalDialog(page).getByRole("alert")).toContainText(`Failed to remove "${two.name}"`);
    expect(deletes.map((request) => request.pathname)).toEqual([`/api/projects/${one.id}`, `/api/projects/${two.id}`]);
    expect((await projects(service)).some((entry) => entry.id === one.id)).toBe(false);
    expect((await projects(service)).map((entry) => entry.id)).toEqual(expect.arrayContaining([two.id, unrelatedId]));
    expect(page.url()).toContain("project=");
    expect((await service.api<{ active_run: { id: string } | null }>("GET", `/api/threads/${activeThread}`)).active_run?.id).toBe(run.id);
    await service.api("POST", `/api/runs/${run.id}/cancel`, {});
    await expect.poll(async () => (await service.api<{ active_run: unknown }>("GET", `/api/threads/${activeThread}`)).active_run).toBeNull();
    await expect(removalDialog(page).getByRole("button", { name: "Confirm", exact: true })).toBeEnabled();
    await removalDialog(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/projects$/);
    expect(deletes.map((request) => request.pathname)).toEqual([`/api/projects/${one.id}`, `/api/projects/${two.id}`, `/api/projects/${two.id}`]);
    expect((await projects(service)).some((entry) => entry.id === unrelatedId)).toBe(true);
    for (const row of [one, two]) expect(readFileSync(join(row.path, "keep-local.txt"), "utf8")).toBe("unchanged local work");
  } finally { await service.stop(); }
});
