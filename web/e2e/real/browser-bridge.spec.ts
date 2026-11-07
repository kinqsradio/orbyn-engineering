import { expect, test, type Locator } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openPanelTab, startProject, type Service } from "./service";

/** Clipboard, file chooser and downloads crossing between a preview and the person. */
const SITE_PORT = 5294;

let service: Service;
let threadId = "";
let site: Server;
const typed: string[] = [];
const received: string[] = [];

/** Three full-width bands: a field that selects itself, a file chooser, a download. */
const PAGE = `<body style="margin:0">
<input id="field" value="copy me out" onfocus="this.select()" oninput="fetch('/typed?v='+encodeURIComponent(this.value))"
  style="display:block;box-sizing:border-box;width:100vw;height:33vh;font-size:32px">
<label for="up" style="display:block;width:100vw;height:33vh;background:#ddf">Upload</label>
<input id="up" type="file" hidden onchange="this.files[0].text().then((t)=>fetch('/got',{method:'POST',body:this.files[0].name+':'+t}))">
<a href="/report.csv" download style="display:block;width:100vw;height:34vh;background:#dfd">Download</a>
</body>`;

test.beforeAll(async () => {
  site = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://site");
    if (url.pathname === "/typed") typed.push(url.searchParams.get("v") ?? "");
    if (url.pathname === "/got") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString()));
      request.on("end", () => {
        received.push(body);
        response.end();
      });
      return;
    }
    if (url.pathname === "/report.csv") {
      response.setHeader("Content-Type", "text/csv");
      response.setHeader("Content-Disposition", 'attachment; filename="../report.csv"');
      response.end("a,b\n1,2\n");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(PAGE);
  }).listen(SITE_PORT);
  const started = await startProject({ fakeEngines: true });
  service = started.service;
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: started.projectId,
    engine: started.engines[0]?.id,
    model: null,
    title: "Bridge",
    worktree: null,
    skill_profile: null,
  });
  threadId = thread.id;
});

test.afterAll(async () => {
  const base = `/api/threads/${threadId}/previews`;
  for (const tab of await service.api<{ id: string }[]>("GET", base)) {
    await service.api("DELETE", `${base}/${tab.id}`);
    await expect.poll(() => existsSync(join(service.dataDir, "preview-files", tab.id))).toBe(false);
  }
  await service.stop();
  site.close();
});

/** Clicks the page's band at `fraction` of its height. */
async function clickBand(frame: Locator, fraction: number) {
  const box = await frame.boundingBox();
  if (!box) throw new Error("the page has no box");
  await frame.click({ position: { x: box.width / 2, y: box.height * fraction } });
}

test("copy, paste, a chosen file and a download cross only on the person's action", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/threads/${threadId}`);
  await expect(page.getByRole("textbox", { name: /^Message/ })).toBeVisible();
  await openPanelTab(page, "Browser");
  const address = page.getByRole("combobox", { name: "Search or enter URL" });
  await address.fill(`localhost:${SITE_PORT}/`);
  await address.press("Enter");
  const frame = page.getByRole("img", { name: /^Page at/ });
  await expect(frame).toBeVisible({ timeout: 40_000 });
  const [tab] = await service.api<{ id: string }[]>("GET", `/api/threads/${threadId}/previews`);
  const base = `/api/threads/${threadId}/previews/${tab?.id}`;

  // Nothing leaves the page for someone who does not hold it.
  await expect(service.api("POST", `${base}/copy`)).rejects.toThrow();
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByRole("button", { name: "Give control back" })).toBeVisible();

  // Copy: the field selects itself on focus, and the shortcut copies that selection.
  await clickBand(frame, 1 / 6);
  await page.evaluate(() => navigator.clipboard.writeText("before"));
  await frame.focus();
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copy me out");

  // Paste: the person's clipboard text is typed where the caret is.
  await clickBand(frame, 1 / 6);
  await page.evaluate(() => navigator.clipboard.writeText("pasted in"));
  await frame.focus();
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => typed.at(-1)).toContain("pasted in");

  // File chooser: the page's click waits for a file the person chooses.
  await clickBand(frame, 0.5);
  await expect(page.getByRole("group", { name: "File chooser" })).toContainText("The page asks for a file.");
  await page.getByLabel("Files for the page").setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("from the person"),
  });
  await expect.poll(() => received.at(-1)).toBe("note.txt:from the person");
  await expect(page.getByRole("group", { name: "File chooser" })).toHaveCount(0);
  const audit = await service.api<{ action: string }[]>("GET", `/api/audit?thread_id=${threadId}`);
  expect(audit.map((entry) => entry.action)).toContain("preview.files");

  // Download: it lands in the tab's folder under the browser's id, and the person saves it.
  await clickBand(frame, 5 / 6);
  const downloads = page.getByRole("list", { name: "Downloads" });
  await expect(downloads).toContainText("report.csv");
  const saving = page.waitForEvent("download");
  await downloads.getByRole("button", { name: "Save" }).click();
  const saved = await saving;
  // The page named it "../report.csv"; no folder survives into the saved name.
  expect(saved.suggestedFilename()).toMatch(/^[^/\\]*report\.csv$/);
  expect(readFileSync(await saved.path(), "utf8")).toBe("a,b\n1,2\n");
});
