import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openPanelTab, startProject, settled, type Service } from "./service";

type Cue = { phase: string; sequence: number; [key: string]: unknown };
let service: Service;
let projectId: string;
let origin: string;
let loads = 0;
const site = createServer((request, response) => {
  if (request.url === "/favicon.ico") {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  // Each served document names itself, so a test can wait for the one it navigated to.
  loads += 1;
  response.end(`<!doctype html><title>load ${loads}</title><body style='margin:0'><button id=go style='position:absolute;left:100px;top:100px;width:100px;height:40px' onclick="document.title='clicked'">Go</button><input id=secret type=password><button id=mark>Mark</button><a id=link href='/next'>Next</a><button id=reload onclick='location.reload()'>Reload</button></body>`);
});

test.beforeAll(async () => {
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  ({ service, projectId } = await startProject({ fakeEngines: true, builtUi: process.env.ORBYN_E2E_BUILT_UI === "1" }));
});

test.afterAll(async () => {
  // Independent cleanup owners always run, even if another owner fails.
  const results = await Promise.allSettled([
    service?.stop(),
    new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve())),
  ]);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason as unknown);
  if (errors.length) throw new AggregateError(errors, "Preview fixture teardown failed");
});

async function withPreview(page: Page, info: TestInfo, work: (context: {
  base: string; tabId: string; threadId: string; cues: Cue[];
  act(args: Record<string, unknown>): Promise<void>;
}) => Promise<void>) {
  const cues: Cue[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname.endsWith("/pointer")) socket.on("framereceived", ({ payload }) => cues.push(JSON.parse(String(payload)) as Cue));
  });
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Input trace" });
  const base = `/api/threads/${thread.id}`;
  await service.api("PATCH", base, { permission_mode: "full_access" });
  const tab = await service.api<{ id: string }>("POST", `${base}/previews`, { url: `${origin}/` });
  let primary: unknown;
  try {
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await openPanelTab(page, "Browser");
    const picture = page.getByRole("img", { name: /^Page at/ });
    await expect(picture).toBeVisible();
    await expect.poll(async () => {
      const box = await picture.boundingBox();
      const [current] = await service.api<{ width: number }[]>("GET", `${base}/previews`);
      return box && current ? Math.abs(current.width - Math.max(100, Math.round(box.width))) : Infinity;
    }).toBeLessThanOrEqual(8);
    const act = async (args: Record<string, unknown>) => test.step(`Preview ${String(args.action)} ${String(args.selector ?? "page")}`, async () => {
      await service.api("POST", `${base}/runs`, { prompt: `[mcp-call:orbyn_preview_act]${JSON.stringify({ tab_id: tab.id, ...args })}[/mcp-call]` });
      await settled(service, thread.id);
    });
    await work({ base, tabId: tab.id, threadId: thread.id, cues, act });
  } catch (error) {
    primary = error;
    await info.attach("preview-pointer-events", { body: JSON.stringify(cues, null, 2), contentType: "application/json" });
  }
  let cleanupError: unknown;
  try {
    await service.api("DELETE", `${base}/previews/${tab.id}`);
    await expect.poll(() => existsSync(join(service.dataDir, "preview-profiles", tab.id))).toBe(false);
  } catch (error) { cleanupError = error; }
  if (primary) {
    if (cleanupError) await info.attach("preview-cleanup-error", { body: String(cleanupError), contentType: "text/plain" });
    throw primary;
  }
  if (cleanupError) throw cleanupError;
}

// A late clear from the page settling is not a pointer; only a move or click would be fabricated.
const pointers = (cues: Cue[]) => cues.filter((cue) => cue.phase !== "clear");

test("approved MCP input reaches the page; failed clicks and typing emit no fabricated pointer", async ({ page }, info) => {
  await withPreview(page, info, async ({ base, cues, act }) => {
    const run = act({ action: "click", selector: "#go" });
    await expect(page.locator("[data-agent-browser-cursor]")).toBeVisible();
    await run;
    await expect.poll(() => cues.some((cue) => cue.phase === "click")).toBe(true);
    const click = cues.find((cue) => cue.phase === "click");
    expect(click?.x).toBe(150);
    expect(click?.y).toBe(120);
    expect(Object.keys(click ?? {}).sort()).toEqual(["height", "phase", "sequence", "width", "x", "y"]);
    await expect.poll(async () => (await service.api<{ title: string }[]>("GET", `${base}/previews`))[0]?.title).toBe("clicked");
    await expect(page.locator("[data-agent-browser-cursor]")).toHaveCount(0);
    const before = pointers(cues).length;
    await act({ action: "click", selector: "#absent" });
    expect(pointers(cues)).toHaveLength(before);
    await act({ action: "type", selector: "#secret", text: "synthetic-password" });
    expect(pointers(cues)).toHaveLength(before);
    expect(JSON.stringify(cues)).not.toMatch(/synthetic-password|#secret|127\.0\.0\.1/);
  });
});

test("page evaluation and denied input cannot publish an agent pointer", async ({ page }, info) => {
  await withPreview(page, info, async ({ base, tabId, threadId, cues }) => {
    const before = pointers(cues).length;
    await service.api("POST", `${base}/runs`, { prompt: `[mcp-call:orbyn_preview_evaluate]${JSON.stringify({ tab_id: tabId, expression: "document.querySelector('#go').click()" })}[/mcp-call]` });
    await settled(service, threadId);
    expect(pointers(cues)).toHaveLength(before);
    await service.api("PATCH", base, { permission_mode: "supervised" });
    await service.api("POST", `${base}/runs`, { prompt: `[mcp-call:orbyn_preview_act]${JSON.stringify({ tab_id: tabId, action: "click", selector: "#go" })}[/mcp-call]` });
    let approvalId = "";
    await expect.poll(async () => {
      const approvals = await service.api<{ id: string; thread_id: string }[]>("GET", "/api/approvals?state=pending");
      approvalId = approvals.find((approval) => approval.thread_id === threadId)?.id ?? "";
      return approvalId;
    }).not.toBe("");
    await service.api("POST", `/api/approvals/${approvalId}/decide`, { allow: false, remember: false });
    await settled(service, threadId);
    expect(pointers(cues)).toHaveLength(before);
  });
});

test("link navigation and same-URL reload clear the cursor and allow later legitimate clicks", async ({ page }, info) => {
  await withPreview(page, info, async ({ base, cues, act }) => {
    for (const selector of ["#link", "#reload"]) {
      const served = loads;
      // Click only the document that was served last, never one still loading.
      await expect.poll(async () => (await service.api<{ title: string }[]>("GET", `${base}/previews`))[0]?.title, { timeout: 20_000 }).toBe(`load ${served}`);
      const before = cues.at(-1)?.sequence ?? 0;
      await act({ action: "click", selector });
      await expect.poll(() => cues.some((cue) => cue.sequence > before && cue.phase === "clear")).toBe(true);
      // The next click needs the new document, not the one being unloaded.
      await expect.poll(async () => (await service.api<{ title: string }[]>("GET", `${base}/previews`))[0]?.title, { timeout: 20_000 }).toBe(`load ${served + 1}`);
      expect(cues.at(-1)?.phase).toBe("clear");
      await expect(page.locator("[data-agent-browser-cursor]")).toHaveCount(0);
      const cleared = cues.at(-1)?.sequence ?? 0;
      const legitimate = act({ action: "click", selector: "#mark" });
      await expect(page.locator("[data-agent-browser-cursor]")).toBeVisible();
      await legitimate;
      expect(cues.some((cue) => cue.sequence > cleared && cue.phase === "click")).toBe(true);
    }
    await expect.poll(async () => (await service.api<{ url: string }[]>("GET", `${base}/previews`))[0]?.url).toBe(`${origin}/next`);
  });
});
