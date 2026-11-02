//! Local image choices through real private checkout roots and metadata commands.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Project } from "../../src/generated/Project";
import type { ProjectScopeCatalog } from "../../src/generated/ProjectScopeCatalog";
import { startProject, type Service } from "./service";

const searchPath = "/api/settings/projects/image-search";
const changePath = "/api/settings/projects/image";
const chooser = (page: Page) => page.getByRole("button", { name: "Choose a project icon file", exact: true });
const picker = (page: Page) => page.getByRole("dialog", { name: "Choose project icon", exact: true });
const search = (page: Page) => picker(page).getByRole("combobox", { name: "Search image files", exact: true });
const candidate = (page: Page, path: string) => picker(page).getByRole("option").filter({ has: page.getByText(path, { exact: true }) });
const iconRow = (page: Page) => page.locator(".setting-line").filter({ has: page.getByText("Project icon", { exact: true }) });
const projects = (service: Service) => service.api<Project[]>("GET", "/api/projects");
function svg(color = "blue") { return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${color}"/></svg>`; }
function file(project: Project, path: string, bytes: string | Buffer = svg()) {
  const full = join(project.path, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, bytes); return full;
}
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
async function fixture() {
  const { service, projectId: unrelatedId } = await startProject();
  const members: Project[] = [];
  for (const name of ["image-one", "image-two"]) {
    const project = await service.api<Project>("POST", "/api/projects/create", { name, readme: true });
    execFileSync("git", ["-C", project.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Images/Shared.git"], { stdio: "ignore" });
    members.push(project);
  }
  const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {});
  const group = catalog.groups.find((group) => group.members.some((member) => member.project_id === members[0]!.id))!;
  const unrelated = catalog.groups.find((group) => group.members.some((member) => member.project_id === unrelatedId))!;
  const url = `${service.page}#/settings/projects?project=${encodeURIComponent(group.key)}`;
  return { service, members, group, unrelated, unrelatedId, url };
}
function writes(page: Page) {
  const requests: Record<string, unknown>[] = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === changePath) requests.push(request.postDataJSON() as Record<string, unknown>); });
  return requests;
}
async function resource(service: Service, id: string) { return service.api<{ image: { source: string; relative_path: string; revision: string; size: number } | null }>("GET", `/api/projects/${id}/icon/resource`); }
async function ignoreSearchAbort(page: Page) {
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return fetch(input, new URL(url, location.href).pathname === "/api/settings/projects/image-search" ? { ...init, signal: undefined } : init);
    };
  });
}

test("image search supports empty queries, keyboard selection and cancellation without writes", async ({ page }, info) => {
  const { service, members: [one], group, url } = await fixture(); const requests = writes(page);
  try {
    await page.goto(url); await chooser(page).click();
    await expect(search(page)).toBeFocused(); await expect(picker(page).getByRole("status")).toHaveText("No image files found.");
    await page.keyboard.press("Escape"); await expect(picker(page)).toHaveCount(0); await expect(chooser(page)).toBeFocused(); expect(requests).toEqual([]);
    file(one!, "assets/first.svg"); file(one!, "assets/second.svg");
    await chooser(page).click(); await expect(picker(page).getByRole("option")).toHaveCount(2);
    await expect(picker(page).getByRole("group", { name: group.label, exact: true })).toBeVisible();
    await search(page).fill("no-such-image"); await expect(picker(page).getByRole("status")).toHaveText("No matching image files.");
    await expect(picker(page).getByRole("option")).toHaveCount(0); await search(page).fill(""); await expect(picker(page).getByRole("option")).toHaveCount(2);
    await search(page).dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(picker(page)).toBeVisible(); expect(requests).toEqual([]);
    await page.screenshot({ path: info.outputPath("image-search.png") });
    await page.mouse.click(8, 8); await expect(picker(page)).toHaveCount(0); expect(requests).toEqual([]);
    await chooser(page).click(); await expect(picker(page).getByRole("option")).toHaveCount(2); await search(page).press("ArrowDown");
    const selected = await picker(page).getByRole("option", { selected: true }).locator(".project-image-entry > span + span").innerText();
    await search(page).press("Enter"); await expect(picker(page)).toHaveCount(0);
    await expect.poll(async () => (await projects(service)).find((row) => row.id === one!.id)?.favicon_path).toBe(selected);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ scope: { selection: { kind: "project_group", group_key: group.key } }, path: selected });
  } finally { await service.stop(); }
});

test("relative image choices fan out while missing peer files fall back and reset preserves files", async ({ page }) => {
  const { service, members: [one, two], group, unrelatedId, url } = await fixture();
  const chosen = file(one!, "assets/shared.svg", svg("green")); const firstFallback = file(one!, "favicon.svg", svg("red")); const secondFallback = file(two!, "favicon.svg", svg("orange"));
  const before = [chosen, firstFallback, secondFallback].map((path) => [path, digest(path)] as const);
  const initial = await projects(service);
  try {
    const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", { selection: { kind: "project_group", group_key: group.key } });
    await service.api("POST", "/api/settings/projects/icon", { scope: { selection: { kind: "project_group", group_key: group.key } }, membership_version: catalog.version,
      expected_revisions: Object.fromEntries(catalog.groups.find((entry) => entry.key === group.key)!.members.map((member) => [member.project_id, member.metadata_revision])), icon: { kind: "lucide", name: "rocket", color: "blue" } });
    await page.goto(url); await chooser(page).click(); await search(page).fill("shared"); await candidate(page, "assets/shared.svg").click(); await expect(picker(page)).toHaveCount(0);
    await expect.poll(async () => (await projects(service)).filter((row) => [one!.id, two!.id].includes(row.id)).map((row) => ({ path: row.favicon_path, icon: row.project_icon })))
      .toEqual([{ path: "assets/shared.svg", icon: null }, { path: "assets/shared.svg", icon: null }]);
    expect((await resource(service, one!.id)).image).toMatchObject({ source: "saved_image", relative_path: "assets/shared.svg" });
    expect((await resource(service, two!.id)).image).toMatchObject({ source: "automatic", relative_path: "favicon.svg" });
    expect((await projects(service)).find((row) => row.id === unrelatedId)?.favicon_path ?? null).toBeNull();
    await expect(page.getByRole("button", { name: "Reset project icon", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Reset project icon", exact: true }).click();
    await expect.poll(async () => (await projects(service)).filter((row) => [one!.id, two!.id].includes(row.id)).every((row) => !row.project_icon && !row.favicon_path)).toBe(true);
    await expect(chooser(page)).toBeEnabled(); await page.getByRole("button", { name: "Choose a project icon", exact: true }).click();
    await picker(page).getByRole("button", { name: "Emoji", exact: true }).click(); await picker(page).getByRole("button", { name: "Robot", exact: true }).click(); await picker(page).getByRole("button", { name: "Save icon", exact: true }).click();
    await expect.poll(async () => (await projects(service)).filter((row) => [one!.id, two!.id].includes(row.id)).every((row) => row.project_icon?.kind === "emoji" && !row.favicon_path)).toBe(true);
    for (const [path, hash] of before) expect(digest(path)).toBe(hash);
    for (const original of initial) { const row = (await projects(service)).find((row) => row.id === original.id)!; expect([row.path, row.trusted, row.name]).toEqual([original.path, original.trusted, original.name]); }
  } finally { await service.stop(); }
});

test("pending image queries hide old entries and late replies cannot replace the current query", async ({ page }) => {
  const { service, members: [one], url } = await fixture(); file(one!, "slow.svg"); file(one!, "fast.svg"); const requests = writes(page);
  await ignoreSearchAbort(page);
  let releaseSlow!: () => void; const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let gotSlow!: () => void; const slowReady = new Promise<void>((resolve) => { gotSlow = resolve; });
  let slowDone!: () => void; const slowFinished = new Promise<void>((resolve) => { slowDone = resolve; });
  let releaseFast!: () => void; const fast = new Promise<void>((resolve) => { releaseFast = resolve; });
  let gotFast!: () => void; const fastReady = new Promise<void>((resolve) => { gotFast = resolve; });
  let holdFast = false;
  await page.route(`**${searchPath}`, async (route) => {
    const query = (route.request().postDataJSON() as { query: string }).query;
    if (query === "error") { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "unavailable", message: "Fixture image search failed" }) }); return; }
    if (query === "slow") { const response = await route.fetch(); gotSlow(); await slow; await route.fulfill({ response }); slowDone(); return; }
    if (query === "fast" && holdFast) { const response = await route.fetch(); gotFast(); await fast; await route.fulfill({ response }); return; }
    await route.continue();
  });
  try {
    await page.goto(url); await chooser(page).click(); await expect(picker(page).getByRole("option")).toHaveCount(2);
    await search(page).fill("slow"); await slowReady; await expect(picker(page).getByRole("option")).toHaveCount(0); await expect(picker(page).getByRole("status")).toHaveText("Searching project files…");
    await search(page).fill("fast"); await expect(candidate(page, "fast.svg")).toBeVisible(); releaseSlow(); await slowFinished;
    await expect(search(page)).toHaveValue("fast"); await expect(candidate(page, "slow.svg")).toHaveCount(0); await expect(picker(page).getByRole("option")).toHaveCount(1);
    await search(page).fill("nothing"); await expect(picker(page).getByRole("status")).toHaveText("No matching image files."); holdFast = true; await search(page).fill("fast"); await fastReady;
    await expect(picker(page).getByRole("option")).toHaveCount(0); releaseFast(); await expect(candidate(page, "fast.svg")).toBeVisible();
    await search(page).fill("error"); await expect(picker(page).getByRole("alert")).toHaveText("Fixture image search failed"); await expect(picker(page).getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Escape"); expect(requests).toEqual([]);
  } finally { releaseSlow(); releaseFast(); await service.stop(); }
});

test("late image search from a prior scope cannot change a new picker", async ({ page }) => {
  const { service, members: [one], unrelated, url } = await fixture(); file(one!, "old.svg"); writeFileSync(join(service.repo, "other.svg"), svg("red")); const requests = writes(page);
  await ignoreSearchAbort(page); let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let ready!: () => void; const captured = new Promise<void>((resolve) => { ready = resolve; }); let finished!: () => void; const done = new Promise<void>((resolve) => { finished = resolve; }); let first = true;
  await page.route(`**${searchPath}`, async (route) => { if (!first) { await route.continue(); return; } first = false; const response = await route.fetch(); ready(); await held; await route.fulfill({ response }); finished(); });
  try {
    await page.goto(url); await chooser(page).click(); await captured;
    await page.goto(`${service.page}#/settings/projects?project=${encodeURIComponent(unrelated.key)}`); await chooser(page).click(); await expect(candidate(page, "other.svg")).toBeVisible();
    release(); await done; await expect(candidate(page, "old.svg")).toHaveCount(0); await expect(picker(page).getByRole("group", { name: unrelated.label, exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); expect(requests).toEqual([]);
  } finally { release(); await service.stop(); }
});

test("stale image revisions or membership close without replay and a reopen observes fresh targets", async ({ page }) => {
  const { service, members: [one, two], group, url } = await fixture(); file(one!, "shared.svg"); const requests = writes(page);
  const choose = async () => { await expect(chooser(page)).toBeEnabled(); await chooser(page).click(); await search(page).fill("shared"); await expect(candidate(page, "shared.svg")).toBeVisible(); };
  const reject = async () => {
    const response = page.waitForResponse((response) => new URL(response.url()).pathname === changePath && response.request().method() === "POST");
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/project-scopes" && response.request().method() === "POST");
    await candidate(page, "shared.svg").click(); await expect(picker(page)).toHaveCount(0); expect((await response).status()).toBe(409); await refreshed; await expect(chooser(page)).toBeEnabled();
    await expect(page.getByRole("status").filter({ hasText: "Settings changed. Reload this scope before saving." })).toBeVisible();
  };
  try {
    await page.goto(url); await choose(); await service.api("PATCH", `/api/projects/${one!.id}`, { name: "Renamed while picking" }); await reject(); expect(requests).toHaveLength(1);
    await choose(); const added = await service.api<Project>("POST", "/api/projects/create", { name: "image-three", readme: true }); execFileSync("git", ["-C", added.path, "config", "--local", "remote.origin.url", "https://fixture.invalid/Images/Shared.git"], { stdio: "ignore" });
    await reject(); expect(requests).toHaveLength(2); expect((await projects(service)).filter((row) => [one!.id, two!.id, added.id].includes(row.id)).every((row) => !row.favicon_path)).toBe(true);
    await choose(); await candidate(page, "shared.svg").click(); await expect(picker(page)).toHaveCount(0);
    await expect.poll(async () => (await projects(service)).filter((row) => [one!.id, two!.id, added.id].includes(row.id)).every((row) => row.favicon_path === "shared.svg")).toBe(true);
    expect(requests).toHaveLength(3); expect(Object.keys(requests[2]!.expected_revisions as object).sort()).toEqual([one!.id, two!.id, added.id].sort());
    expect(requests[2]).toMatchObject({ scope: { selection: { kind: "project_group", group_key: group.key } } });
  } finally { await service.stop(); }
});

function bitmap(shade: number) {
  const width = 900, height = 600, pixels = width * height * 3;
  const bytes = Buffer.alloc(54 + pixels, shade); bytes.write("BM"); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(0, 6); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(0, 30); bytes.writeUInt32LE(pixels, 34); bytes.fill(0, 38, 54); return bytes;
}
test("a valid image over one MiB streams in place and reselecting its path refreshes bytes", async ({ page }) => {
  const { service, members: [one], url } = await fixture(); const large = file(one!, "assets/large.bmp", bitmap(80)); const original = digest(large);
  try {
    await page.goto(`${url}&checkout=${encodeURIComponent(one!.id)}`); await chooser(page).click(); await search(page).fill("large");
    const thumbnail = candidate(page, "assets/large.bmp").locator("img"); await expect(thumbnail).toHaveJSProperty("naturalWidth", 900);
    await candidate(page, "assets/large.bmp").click(); await expect(picker(page)).toHaveCount(0);
    await expect(iconRow(page).locator("img")).toHaveJSProperty("complete", true); await expect.poll(async () => (await resource(service, one!.id)).image?.size ?? 0).toBeGreaterThan(1024 * 1024);
    const first = (await resource(service, one!.id)).image!; const previous = await iconRow(page).locator("img").getAttribute("src"); expect(digest(large)).toBe(original);
    writeFileSync(large, bitmap(180)); const changed = digest(large); expect(changed).not.toBe(original);
    await expect(chooser(page)).toBeEnabled(); await chooser(page).click(); await search(page).fill("large"); await candidate(page, "assets/large.bmp").click();
    await expect.poll(async () => (await resource(service, one!.id)).image?.revision).not.toBe(first.revision);
    await expect.poll(async () => iconRow(page).locator("img").getAttribute("src")).not.toBe(previous);
    expect(digest(large)).toBe(changed);
  } finally { await service.stop(); }
});

test("candidate previews stay lazy, bounded and inert for SVG with decode fallback", async ({ page }, info) => {
  const { service, members: [one], url } = await fixture(); const requests: string[] = [];
  file(one!, "000-broken.png", "not an image");
  const unsafe = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><script>window.fixtureSvgExecuted=true;fetch("https://fixture.invalid/executed")</script><image href="https://fixture.invalid/external.png"/><rect width="32" height="32" fill="green"/></svg>';
  file(one!, "001-inert.svg", unsafe); for (let index = 0; index < 210; index++) file(one!, `assets/image-${String(index).padStart(3, "0")}.svg`);
  page.on("request", (request) => requests.push(request.url()));
  try {
    await page.goto(url); await chooser(page).click(); await expect(picker(page).getByRole("option")).toHaveCount(200);
    await expect(candidate(page, "001-inert.svg").locator("img")).toHaveJSProperty("naturalWidth", 32);
    await expect(candidate(page, "000-broken.png").locator(".lucide-file")).toBeVisible(); await expect(candidate(page, "000-broken.png").locator("img")).toHaveCount(0);
    const last = picker(page).getByRole("option").last(); await expect(last.locator("img")).toHaveCount(0);
    expect(requests.filter((url) => new URL(url).pathname.endsWith("/images/raw")).length).toBeLessThan(200);
    await last.scrollIntoViewIfNeeded(); await expect(last.locator("img")).toHaveJSProperty("naturalWidth", 32);
    expect(requests.some((url) => url.startsWith("https://fixture.invalid/"))).toBe(false); expect(await page.evaluate(() => Reflect.get(window, "fixtureSvgExecuted"))).toBeUndefined();
    await page.screenshot({ path: info.outputPath("image-search-lazy.png") }); await page.keyboard.press("Escape"); expect(readFileSync(join(one!.path, "001-inert.svg"), "utf8")).toBe(unsafe);
  } finally { await service.stop(); }
});

test("a late committed image response cannot replace a newer project name", async ({ page }, info) => {
  const { service, members: [one, two], url } = await fixture(); file(one!, "shared.svg");
  const initial = (await projects(service)).filter((row) => [one!.id, two!.id].includes(row.id));
  expect(initial).toHaveLength(2);
  const revisionsAfter = (increments: bigint) => Object.fromEntries(initial.map((row) => {
    expect(row.metadata_revision).toMatch(/^(0|[1-9][0-9]*)$/);
    return [row.id, (BigInt(row.metadata_revision!) + increments).toString()];
  }));
  const imageRevisions = revisionsAfter(1n), nameRevisions = revisionsAfter(2n);
  await page.clock.install({ time: new Date("2026-11-02T08:00:00Z") });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void; const imageCommitted = new Promise<void>((resolve) => { captured = resolve; });
  let fulfilled!: () => void; const imageFulfilled = new Promise<void>((resolve) => { fulfilled = resolve; });
  const saved: { status?: number; rows?: Project[] } = {};
  await page.route(`**${changePath}`, async (route) => {
    const response = await route.fetch();
    saved.status = response.status(); saved.rows = await response.json() as Project[];
    captured(); await held; await route.fulfill({ response }); fulfilled();
  });
  try {
    await page.goto(url); await chooser(page).click(); await search(page).fill("shared"); await expect(candidate(page, "shared.svg")).toBeVisible();
    const polled = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "GET");
    await page.clock.pauseAt(new Date("2026-11-02T09:00:00Z")); await (await polled).finished(); await page.clock.runFor(50);
    await candidate(page, "shared.svg").click(); await expect(picker(page)).toHaveCount(0); await imageCommitted;
    expect(saved.status).toBe(200); expect(saved.rows).toHaveLength(2);
    expect(Object.fromEntries(saved.rows!.map((row) => [row.id, row.metadata_revision]))).toEqual(imageRevisions);
    expect(saved.rows!.every((row) => row.favicon_path === "shared.svg")).toBe(true);
    const title = page.getByRole("textbox", { name: "Project name", exact: true });
    const renamed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/projects/rename" && response.request().method() === "POST");
    await title.fill("Newer project name"); await title.press("Enter");
    const response = await renamed; expect(response.status()).toBe(200); const newer = await response.json() as Project[];
    expect(newer).toHaveLength(2);
    expect(Object.fromEntries(newer.map((row) => [row.id, row.metadata_revision]))).toEqual(nameRevisions);
    expect(newer.every((row) => row.name === "Newer project name")).toBe(true);
    const names = page.getByRole("link", { name: "Review trust for Newer project name", exact: true });
    await expect(names).toHaveCount(2);
    await expect.poll(async () => Object.fromEntries((await projects(service)).filter((row) => [one!.id, two!.id].includes(row.id)).map((row) => [row.id, { name: row.name, revision: row.metadata_revision }]))).toEqual(
      Object.fromEntries(initial.map((row) => [row.id, { name: "Newer project name", revision: nameRevisions[row.id] }])),
    );
    await info.attach("committed-image-and-newer-name", { body: JSON.stringify({ image: saved.rows, newer }), contentType: "application/json" });
    const delivered = page.waitForResponse((response) => new URL(response.url()).pathname === changePath && response.request().method() === "POST");
    release(); await imageFulfilled; await (await delivered).finished(); await page.clock.runFor(50);
    await expect(names).toHaveCount(2);
    await page.screenshot({ path: info.outputPath("newer-name-after-late-image.png") });
  } finally { release(); await service.stop(); }
});


test("a late image reply cannot replace a newer known icon when catalog refresh fails", async ({ page }, info) => {
  const { service, members: [one, two], group, url } = await fixture(); file(one!, "shared.svg");
  const ids = [one!.id, two!.id];
  const initial = (await projects(service)).filter((row) => ids.includes(row.id)); expect(initial).toHaveLength(2);
  const revisionsAfter = (increment: bigint) => Object.fromEntries(initial.map((row) => {
    expect(row.metadata_revision).toMatch(/^(0|[1-9][0-9]*)$/);
    return [row.id, (BigInt(row.metadata_revision!) + increment).toString()];
  }));
  const imageRevisions = revisionsAfter(1n), iconRevisions = revisionsAfter(2n);
  const scope = { selection: { kind: "project_group", group_key: group.key } };
  const requests = writes(page); let structuredWrites = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/settings/projects/icon") structuredWrites += 1;
  });
  await page.clock.install({ time: new Date("2026-11-02T08:00:00Z") });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void; const committed = new Promise<void>((resolve) => { captured = resolve; });
  let fulfilled!: () => void; const delivered = new Promise<void>((resolve) => { fulfilled = resolve; });
  let imageRows: Project[] = [];
  await page.route(`**${changePath}`, async (route) => {
    const response = await route.fetch(); expect(response.status()).toBe(200); imageRows = await response.json() as Project[];
    captured(); await held; await route.fulfill({ response }); fulfilled();
  });
  try {
    await page.goto(url); await chooser(page).click(); await search(page).fill("shared"); await expect(candidate(page, "shared.svg")).toBeVisible();
    const initialPoll = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "GET");
    await page.clock.pauseAt(new Date("2026-11-02T09:00:00Z")); await (await initialPoll).finished(); await page.clock.runFor(50);
    await candidate(page, "shared.svg").click(); await expect(picker(page)).toHaveCount(0); await committed;
    expect(Object.fromEntries(imageRows.map((row) => [row.id, row.metadata_revision]))).toEqual(imageRevisions);
    const catalog = await service.api<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", scope);
    const newer = await service.api<Project[]>("POST", "/api/settings/projects/icon", { scope, membership_version: catalog.version,
      expected_revisions: imageRevisions, icon: { kind: "emoji", emoji: "🤖" } });
    expect(Object.fromEntries(newer.map((row) => [row.id, row.metadata_revision]))).toEqual(iconRevisions);
    expect(newer.every((row) => row.project_icon?.kind === "emoji" && row.project_icon.emoji === "🤖" && row.favicon_path === null)).toBe(true);
    // Publish the actual newer server rows through the normal projects poll.
    const newerPoll = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "GET");
    await page.clock.runFor(4000); const polled = await newerPoll;
    expect(Object.fromEntries((await polled.json() as Project[]).filter((row) => ids.includes(row.id)).map((row) => [row.id, row.metadata_revision]))).toEqual(iconRevisions);
    await polled.finished(); await page.clock.runFor(50);
    const sidebarRobots = page.getByRole("navigation", { name: "Workspace", exact: true }).locator(".project-icon-visual").filter({ hasText: "🤖" });
    await expect(sidebarRobots).toHaveCount(2);
    await page.route("**/api/settings/project-scopes", (route) => route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ code: "unavailable", message: "Fixture icon scope read failed" }) }));
    const failedRead = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/project-scopes" && response.status() === 503);
    const imageResponse = page.waitForResponse((response) => new URL(response.url()).pathname === changePath && response.request().method() === "POST");
    release(); await delivered; await (await imageResponse).finished(); await failedRead; await page.clock.runFor(50);
    await expect(page.getByRole("alert").filter({ hasText: "Fixture icon scope read failed" })).toBeVisible();
    await expect(chooser(page)).toBeDisabled();
    await expect(iconRow(page).locator(".setting-line-desc")).toHaveText("🤖");
    await expect(iconRow(page).locator(".project-icon-visual")).toHaveText("🤖");
    await expect(sidebarRobots).toHaveCount(2); expect(requests).toHaveLength(1); expect(structuredWrites).toBe(0);
    expect(Object.fromEntries((await projects(service)).filter((row) => ids.includes(row.id)).map((row) => [row.id, row.metadata_revision]))).toEqual(iconRevisions);
    await info.attach("older-image-newer-icon", { body: JSON.stringify({ initial, imageRows, newer }), contentType: "application/json" });
    await page.screenshot({ path: info.outputPath("newer-icon-after-late-image-failed-read.png") });
  } finally { release(); await service.stop(); }
});
