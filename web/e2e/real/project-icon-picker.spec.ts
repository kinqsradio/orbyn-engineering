//! Structured project identities through real disposable registrations and metadata writes.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../src/generated/Project";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import type { ProjectIconOverride } from "../../src/generated/ProjectIconOverride";
import { startProject, type Service } from "./service";

const endpoint = "/api/settings/projects/icon";
const chooser = (page: Page) => page.getByRole("button", { name: "Choose a project icon", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Choose project icon", exact: true });
const save = (page: Page) => dialog(page).getByRole("button", { name: "Save icon", exact: true });
const iconRow = (page: Page) => page.locator(".setting-line").filter({ has: page.getByText("Project icon", { exact: true }) });
const rows = (service: Service) => service.api<Project[]>("GET", "/api/projects");
async function fixture() {
  const { service, projectId: otherId } = await startProject();
  const members: Project[] = [];
  for (const name of ["icon-one", "icon-two"]) {
    const member = await service.api<Project>("POST", "/api/projects/create", { name, readme: true });
    execFileSync("git", ["-C", member.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Icon/Group.git"], { stdio: "ignore" });
    writeFileSync(join(member.path, "keep.txt"), "untouched");
    writeFileSync(join(member.path, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="blue"/></svg>');
    members.push(member);
  }
  await service.api("POST", `/api/projects/${members[0]!.id}/trust`);
  const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
  const group = catalog.groups.find((group) => group.members.some((member) => member.project_id === members[0]!.id))!;
  const other = catalog.groups.find((group) => group.members.some((member) => member.project_id === otherId))!;
  const url = `${service.page}#/settings/projects?project=${encodeURIComponent(group.key)}`;
  const initial = await rows(service);
  return { service, members, otherId, group, other, url, initial };
}
function writes(page: Page) {
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === endpoint) requests.push(request.postDataJSON() as Record<string, unknown>); });
  return requests;
}
const icons = async (service: Service) => Object.fromEntries((await rows(service)).map((row) => [row.id, row.project_icon ?? null]));
async function change(service: Service, scope: unknown, icon: ProjectIconOverride | null) {
  const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", scope);
  const ids = catalog.selection.kind === "project_group" ? catalog.selection.project_ids
    : catalog.selection.kind === "checkout" ? [catalog.selection.project_id] : [];
  const revisions = Object.fromEntries(catalog.groups.flatMap((group) => group.members).filter((member) => ids.includes(member.project_id)).map((member) => [member.project_id, member.metadata_revision]));
  return service.api<Project[]>("POST", endpoint, { scope, membership_version: catalog.version, expected_revisions: revisions, icon });
}

test("icon drafts cancel without writes and group or checkout saves preserve registration", async ({ page }, info) => {
  const { service, members: [one, two], group, otherId, url, initial } = await fixture();
  const requests = writes(page);
  try {
    await page.goto(`${service.page}#/settings/projects`); await expect(chooser(page)).toHaveCount(0);
    await page.goto(url); await expect(chooser(page)).toBeEnabled(); await chooser(page).click();
    await expect(dialog(page).getByRole("group", { name: "Icon color", exact: true }).getByRole("button")).toHaveCount(18);
    await expect(dialog(page).getByRole("group", { name: "Icons", exact: true }).getByRole("button")).toHaveCount(24);
    await dialog(page).getByRole("button", { name: "Rocket", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click(); expect(requests).toEqual([]);
    await chooser(page).click(); await expect(dialog(page).getByRole("button", { name: "Folder Code", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog(page).locator(".lucide-rocket")).toBeVisible();
    await page.screenshot({ path: info.outputPath("picker-icons.png") });
    await dialog(page).getByRole("searchbox", { name: "Search Lucide icons" }).fill("  rocket  ");
    await dialog(page).getByRole("button", { name: "Rocket", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Blue", exact: true }).click(); await save(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => icons(service)).toMatchObject({ [one!.id]: { kind: "lucide", name: "rocket", color: "blue" }, [two!.id]: { kind: "lucide", name: "rocket", color: "blue" }, [otherId]: null });
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ scope: { selection: { kind: "project_group", group_key: group.key } }, expected_revisions: Object.fromEntries(initial.filter((row) => [one!.id, two!.id].includes(row.id)).map((row) => [row.id, row.metadata_revision])) });
    await expect(iconRow(page).locator(".lucide-rocket")).toBeVisible();
    await page.screenshot({ path: info.outputPath("group-icon.png") });
    await page.goto(`${url}&checkout=${encodeURIComponent(one!.id)}`); await chooser(page).click();
    await dialog(page).getByRole("button", { name: "Emoji", exact: true }).click();
    await expect(dialog(page).getByRole("group", { name: "Emoji", exact: true }).getByRole("button")).toHaveCount(30);
    await expect(dialog(page).getByRole("group", { name: "Icon color", exact: true })).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "Robot", exact: true }).click();
    await page.screenshot({ path: info.outputPath("picker-emoji.png") }); await save(page).click();
    await expect.poll(() => icons(service)).toMatchObject({ [one!.id]: { kind: "emoji", emoji: "🤖" }, [two!.id]: { kind: "lucide", name: "rocket", color: "blue" } });
    await page.getByRole("button", { name: "Reset project icon", exact: true }).click();
    await expect.poll(() => icons(service)).toMatchObject({ [one!.id]: null });
    await expect(iconRow(page).locator("img")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose a project icon file", exact: true })).toBeEnabled();
    for (const before of initial) {
      const after = (await rows(service)).find((row) => row.id === before.id)!;
      expect({ path: after.path, trusted: after.trusted, name: after.name }).toEqual({ path: before.path, trusted: before.trusted, name: before.name });
    }
    expect(readFileSync(join(one!.path, "keep.txt"), "utf8")).toBe("untouched");
    expect(readFileSync(join(two!.path, "keep.txt"), "utf8")).toBe("untouched");
  } finally { await service.stop(); }
});

test("picker Unicode transforms stay separate from received icon values", async ({ page }, info) => {
  const { service, members: [one], group, url } = await fixture();
  const scope = { selection: { kind: "checkout", group_key: group.key, project_id: one!.id } };
  try {
    await change(service, scope, { kind: "monogram", text: "ab", color: "green" });
    expect((await icons(service))[one!.id]).toEqual({ kind: "monogram", text: "ab", color: "green" });
    await page.goto(`${url}&checkout=${encodeURIComponent(one!.id)}`); await chooser(page).click();
    await expect(dialog(page).getByRole("textbox", { name: "Letters", exact: true })).toHaveValue("ab");
    await dialog(page).getByRole("textbox", { name: "Letters", exact: true }).fill("ABC"); await expect(save(page)).toBeDisabled();
    await dialog(page).getByRole("textbox", { name: "Letters", exact: true }).fill(" ａｂ ");
    await page.screenshot({ path: info.outputPath("picker-monogram.png") }); await save(page).click();
    await expect.poll(() => icons(service)).toMatchObject({ [one!.id]: { kind: "monogram", text: "AB", color: "green" } });
    for (const [pasted, expected] of [[" 🇦🇺 trailing", "🇦🇺"], ["1️⃣second", "1️⃣"], ["🏳️‍🌈suffix", "🏳️‍🌈"]]) {
      await expect(chooser(page)).toBeEnabled(); await chooser(page).click(); await dialog(page).getByRole("button", { name: "Emoji", exact: true }).click();
      await dialog(page).getByRole("textbox", { name: "Custom emoji" }).fill(pasted!); await save(page).click();
      await expect.poll(() => icons(service)).toMatchObject({ [one!.id]: { kind: "emoji", emoji: expected } });
    }
    await change(service, scope, { kind: "emoji", emoji: "plain text" });
    expect((await icons(service))[one!.id]).toEqual({ kind: "emoji", emoji: "plain text" });
    await change(service, scope, { kind: "lucide", name: "future-widget", color: "rose" });
    await page.reload(); await expect(iconRow(page).locator(".lucide-folder-code")).toBeVisible();
  } finally { await service.stop(); }
});

test("an icon conflict retains its draft and a committed save survives a failed read", async ({ page }) => {
  const { service, members: [one, two], group, url } = await fixture();
  const requests = writes(page);
  const scope = { selection: { kind: "project_group", group_key: group.key } };
  let failRead = false;
  await page.route("**/api/settings/project-scopes", async (route) => {
    if (failRead) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "Fixture scope read failed" }) });
    else await route.continue();
  });
  try {
    await page.goto(url); await chooser(page).click(); await dialog(page).getByRole("button", { name: "Rocket", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Red", exact: true }).click();
    await change(service, scope, { kind: "emoji", emoji: "✨" }); await save(page).click();
    await expect(dialog(page).getByRole("alert")).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Rocket", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog(page).getByRole("button", { name: "Red", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(save(page)).toBeDisabled(); expect(requests).toHaveLength(1);
    await dialog(page).getByRole("button", { name: "Reload", exact: true }).click();
    await expect(save(page)).toBeEnabled();
    await save(page).click(); await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => icons(service)).toMatchObject({ [one!.id]: { kind: "lucide", name: "rocket", color: "red" }, [two!.id]: { kind: "lucide", name: "rocket", color: "red" } });
    expect(requests).toHaveLength(2);
    await expect(chooser(page)).toBeEnabled(); await chooser(page).click(); await dialog(page).getByRole("button", { name: "Emoji", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Robot", exact: true }).click(); failRead = true; await save(page).click();
    await expect(dialog(page)).toHaveCount(0); await expect(iconRow(page)).toContainText("🤖");
    await expect(chooser(page)).toBeDisabled(); await expect(page.getByRole("alert").filter({ hasText: "Fixture scope read failed" })).toBeVisible();
    expect(requests).toHaveLength(3); failRead = false; await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(chooser(page)).toBeEnabled(); expect(requests).toHaveLength(3);
  } finally { await service.stop(); }
});

test("changed icon membership conflicts and only an explicit save adopts the new members", async ({ page }) => {
  const { service, members, url } = await fixture(); const requests = writes(page);
  try {
    await page.goto(url); await chooser(page).click(); await dialog(page).getByRole("button", { name: "Rocket", exact: true }).click();
    const added = await service.api<Project>("POST", "/api/projects/create", { name: "icon-three", readme: true });
    execFileSync("git", ["-C", added.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Icon/Group.git"], { stdio: "ignore" });
    await save(page).click(); await expect(dialog(page).getByRole("alert")).toBeVisible();
    await expect(save(page)).toBeDisabled(); expect(requests).toHaveLength(1);
    await dialog(page).getByRole("button", { name: "Reload", exact: true }).click();
    await expect(save(page)).toBeEnabled();
    expect((await rows(service)).filter((row) => [...members, added].some((member) => member.id === row.id)).every((row) => !row.project_icon)).toBe(true);
    await save(page).click(); await expect(dialog(page)).toHaveCount(0);
    expect(Object.keys(requests[1]!.expected_revisions as object).sort()).toEqual([...members.map((member) => member.id), added.id].sort());
    await expect.poll(() => icons(service)).toMatchObject(Object.fromEntries([...members, added].map((member) => [member.id, expect.objectContaining({ kind: "lucide", name: "rocket" })])));
  } finally { await service.stop(); }
});

test("a delayed icon result cannot close or replace another selection's draft", async ({ page }) => {
  const { service, members, other, otherId, url } = await fixture();
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let committed!: () => void; const written = new Promise<void>((resolve) => { committed = resolve; });
  let first = true;
  await page.route(`**${endpoint}`, async (route) => {
    if (!first) { await route.continue(); return; } first = false;
    const response = await route.fetch(); committed(); await held; await route.fulfill({ response });
  });
  try {
    await page.goto(url); await chooser(page).click(); await dialog(page).getByRole("button", { name: "Rocket", exact: true }).click(); await save(page).click(); await written;
    await page.goto(`${service.page}#/settings/projects?project=${encodeURIComponent(other.key)}`);
    await expect(page.getByRole("textbox", { name: "Project name", exact: true })).toHaveValue(other.label);
    await chooser(page).click(); await dialog(page).getByRole("button", { name: "Monogram", exact: true }).click();
    await dialog(page).getByRole("textbox", { name: "Letters", exact: true }).fill("XY"); release();
    await expect(dialog(page).getByRole("textbox", { name: "Letters", exact: true })).toHaveValue("XY");
    await save(page).click(); await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => icons(service)).toMatchObject({ [otherId]: expect.objectContaining({ kind: "monogram", text: "XY" }), ...Object.fromEntries(members.map((member) => [member.id, expect.objectContaining({ kind: "lucide", name: "rocket" })])) });
  } finally { release(); await service.stop(); }
});

test("missing metadata revisions disable icon writes without assuming revision zero", async ({ page }) => {
  const { service, url } = await fixture(); const requests = writes(page);
  await page.route("**/api/settings/project-scopes", async (route) => {
    const response = await route.fetch(); const catalog = await response.json() as ProjectScopeCatalog;
    for (const group of catalog.groups) for (const member of group.members) delete member.metadata_revision;
    await route.fulfill({ response, json: catalog });
  });
  try { await page.goto(url); await expect(chooser(page)).toBeDisabled(); expect(requests).toEqual([]); }
  finally { await service.stop(); }
});
