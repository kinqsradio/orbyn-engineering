import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { startProject, type Service } from "./service";

let service: Service;
let projectId: string;
let origin: string;
const site = createServer((request, response) => {
  const mode = new URL(request.url ?? "/", "http://fixture").pathname.slice(1);
  const field = mode === "password" ? "<input id=target type=password value=synthetic-password>"
    : mode === "otp" ? "<input id=target autocomplete=one-time-code value=123456>"
    : mode === "iframe" ? "<iframe id=target srcdoc=\"<input autofocus onkeydown=parent.postMessage('down','*') onkeyup=parent.postMessage('up','*')>\"></iframe>"
    : ["shadow", "body", "closed-body"].includes(mode) ? "<div id=target></div>"
    : "<button id=target onclick=\"document.title='clicked'\">Safe control</button>";
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><body style="margin:0;background:#000;color:#fff">${field}<script>
    let down=0,up=0;
    const mark=kind=>{if(kind==='down')down++;else up++;document.title=down+':'+up;};
    document.addEventListener('keydown',()=>mark('down'));
    document.addEventListener('keyup',()=>mark('up'));
    addEventListener('message',e=>{if(e.source===document.querySelector('iframe')?.contentWindow)mark(e.data);});
    const target=document.querySelector('#target');
    if(${JSON.stringify(mode)}==='closed-body'){
      const root=document.body.attachShadow({mode:'closed'});root.innerHTML='<input value=synthetic-closed>';root.firstChild.focus();document.title='ready';
    }else if(${JSON.stringify(mode)}==='design-mode'){
      document.designMode='on';target.focus();document.title='ready';
    }else if(${JSON.stringify(mode)}==='shadow'){
      const root=target.attachShadow({mode:'open'});root.innerHTML='<input value=synthetic-shadow>';root.firstChild.focus();document.title='ready';
    }else if(${JSON.stringify(mode)}==='iframe'){
      target.addEventListener('load',()=>{target.contentDocument.querySelector('input').focus();document.title='ready';});
    }else{target.focus();document.title='ready';}
  </script>`);
});

test.beforeAll(async () => {
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  ({ service, projectId } = await startProject({ fakeEngines: true, builtUi: process.env.ORBYN_E2E_BUILT_UI === "1" }));
});

test.afterAll(async () => {
  const results = await Promise.allSettled([
    service?.stop(),
    new Promise<void>((resolve, reject) => site.close((error) => error ? reject(error) : resolve())),
  ]);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason as unknown);
  if (errors.length) throw new AggregateError(errors, "Recording fixture teardown failed");
});

// Decode the saved artifact in the test browser; this never reads a user's browser profile.
async function badgeBrightness(page: Page, path: string, mouseRing = false): Promise<number> {
  const jpeg = (await readFile(path)).toString("base64");
  return page.evaluate(async ({ base64, mouseRing }) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing JPEG decoder canvas");
    context.drawImage(image, 0, 0);
    const pixels = mouseRing
      ? context.getImageData(38, 0, 24, 24).data
      : context.getImageData(8, image.height - 38, 170, 30).data;
    let brightest = 0;
    for (let i = 0; i < pixels.length; i += 4) brightest = Math.max(brightest,
      mouseRing ? (pixels[i + 2] ?? 0) - (pixels[i] ?? 0) : pixels[i] ?? 0);
    return brightest;
  }, { base64: jpeg, mouseRing });
}

// The viewer dispatches input asynchronously. A Playwright press finishing only
// means its DOM handler ran; recording cues belong to the completed service input.
async function appliedInput(page: Page, endpoint: string, kind: string, dispatch: () => Promise<void>) {
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `${endpoint}/input`
      && (response.request().postDataJSON() as { kind?: string }).kind === kind),
    dispatch(),
  ]);
  expect(response.ok()).toBe(true);
}

test("UI recording options sample static pages and opt in to actual click and key pixels", async ({ page }, info) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Recording options" });
  const base = `/api/threads/${thread.id}`;
  const tab = await service.api<{ id: string }>("POST", `${base}/previews`, { url: `${origin}/button`, width: 400, height: 200 });
  const endpoint = `${base}/previews/${tab.id}`;
  const artifacts = join(service.dataDir, "browser-artifacts");
  let primary: unknown;
  try {
    await page.goto(`${service.page}#/preview/${thread.id}/${tab.id}`);
    const picture = page.getByRole("img", { name: /^Page at/ });
    await expect(picture).toBeVisible();
    await page.getByRole("button", { name: "Take control", exact: true }).click();
    await expect(picture).toHaveAttribute("data-human", "true");
    const clicks = page.getByRole("checkbox", { name: "Show clicks" });
    const keys = page.getByRole("checkbox", { name: "Show navigation keys" });
    await expect(clicks).not.toBeChecked();
    await expect(keys).not.toBeChecked();
    const receipts: unknown[] = [];
    const folders = new Set<string>();
    for (const overlays of [false, true]) {
      await page.getByRole("combobox", { name: "Recording maximum FPS" }).selectOption(overlays ? "10" : "1");
      if (overlays) { await clicks.check(); await keys.check(); }
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stop recording", exact: true })).toBeEnabled();
      expect(await page.getByRole("combobox", { name: "Recording maximum FPS" }).count()).toBe(0);
      const folder = (await readdir(artifacts)).find((name) => name.startsWith(`${tab.id}-`) && !folders.has(name));
      if (!folder) throw new Error("Missing new owned recording folder");
      folders.add(folder);
      const path = join(artifacts, folder);
      await expect.poll(async () => (await readdir(path)).filter((name) => name.endsWith(".jpg")).length).toBeGreaterThan(0);
      if (overlays) {
        const box = await picture.boundingBox();
        if (!box) throw new Error("Missing preview image geometry");
        await appliedInput(page, endpoint, "click", () => picture.click({ position: { x: box.width * 50 / 400, y: box.height * 10 / 200 } }));
        await picture.focus();
        await appliedInput(page, endpoint, "key", () => picture.press("Enter"));
        await expect.poll(async () => (await service.api<{ title: string }[]>("GET", `${base}/previews`))[0]?.title).toBe("1:1");
        // Earlier static frames do not prove that either input cue was sampled.
        const applied = (await readdir(path)).filter((name) => name.endsWith(".jpg")).length;
        await expect.poll(async () => (await readdir(path)).filter((name) => name.endsWith(".jpg")).length).toBeGreaterThan(applied + 1);
      }
      await expect.poll(async () => (await readdir(path)).filter((name) => name.endsWith(".jpg")).length).toBeGreaterThan(1);
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Recording folder" })).toHaveValue(path);
      const summary = JSON.parse(await readFile(join(path, "recording.json"), "utf8")) as {
        fps: number; frames: number; error: string | null; timestamps_ms: number[]; show_key_presses: boolean; show_mouse_presses: boolean;
      };
      expect(summary.error).toBeNull();
      expect(summary.fps).toBe(overlays ? 10 : 1);
      expect(summary.show_key_presses).toBe(overlays);
      expect(summary.show_mouse_presses).toBe(overlays);
      const frames = (await readdir(path)).filter((name) => name.endsWith(".jpg")).sort();
      expect(frames).toHaveLength(summary.frames);
      await expect(page.getByText(`Saved ${summary.frames} frames.`, { exact: true })).toBeVisible();
      const keyPixels: number[] = [], mousePixels: number[] = [];
      for (const frame of frames) {
        keyPixels.push(await badgeBrightness(page, join(path, frame)));
        mousePixels.push(await badgeBrightness(page, join(path, frame), true));
      }
      if (overlays) {
        expect(Math.max(...keyPixels)).toBeGreaterThan(160);
        expect(Math.max(...mousePixels)).toBeGreaterThan(60);
      } else {
        expect(Math.max(...keyPixels)).toBeLessThan(70);
        expect(Math.max(...mousePixels)).toBeLessThan(60);
        for (let i = 1; i < summary.timestamps_ms.length; i++) {
          expect(summary.timestamps_ms[i]! - summary.timestamps_ms[i - 1]!).toBeGreaterThanOrEqual(900);
        }
      }
      receipts.push({ summary, keyPixels, mousePixels });
    }
    await page.setViewportSize({ width: 420, height: 700 });
    await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeVisible();
    await info.attach("recording-options-narrow", { body: await page.screenshot(), contentType: "image/png" });
    await info.attach("recording-options-oracles", { body: JSON.stringify(receipts), contentType: "application/json" });
  } catch (error) { primary = error; }
  try { await service.api("DELETE", endpoint); }
  catch (error) {
    if (!primary) throw error;
    await info.attach("recording-cleanup-error", { body: String(error), contentType: "text/plain" });
  }
  if (primary) throw primary;
});

for (const mode of ["button", "password", "otp", "iframe", "shadow", "body", "closed-body", "design-mode"]) {
  test(`human key dispatch survives ${mode} focus while recording labels follow privacy eligibility`, async ({ page }, info) => {
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Recording privacy" });
    const base = `/api/threads/${thread.id}`;
    const tab = await service.api<{ id: string }>("POST", `${base}/previews`, { url: `${origin}/${mode}`, width: 400, height: 200 });
    const endpoint = `${base}/previews/${tab.id}`;
    let primary: unknown;
    try {
      await expect.poll(async () => (await service.api<{ title: string }[]>("GET", `${base}/previews`))[0]?.title).toBe("ready");
      // The browser-served dedicated viewer keeps the fixture's fixed viewport.
      // This uses the existing image keydown handler, not a fabricated API input.
      await page.goto(`${service.page}#/preview/${thread.id}/${tab.id}`);
      const picture = page.getByRole("img", { name: /^Page at/ });
      await expect(picture).toBeVisible();
      await page.getByRole("button", { name: "Take control", exact: true }).click();
      await expect(picture).toHaveAttribute("data-human", "true");
      await service.api("POST", `${endpoint}/recording?fps=10&show_key_presses=true&show_mouse_presses=false`);
      const artifacts = join(service.dataDir, "browser-artifacts");
      const folder = (await readdir(artifacts)).find((name) => name.startsWith(`${tab.id}-`));
      if (!folder) throw new Error("Missing owned recording folder");
      const path = join(artifacts, folder);
      await expect.poll(async () => (await readdir(path)).filter((name) => name.endsWith(".jpg")).length).toBeGreaterThan(0);
      await picture.focus();
      await appliedInput(page, endpoint, "key", () => picture.press(mode === "button" ? "Enter" : "Backspace"));
      const applied = (await readdir(path)).filter((name) => name.endsWith(".jpg")).length;
      // The page event oracle is independent of pixels and recording metadata.
      await expect.poll(async () => (await service.api<{ title: string }[]>("GET", `${base}/previews`))[0]?.title).toBe("1:1");
      await expect.poll(async () => (await readdir(path)).filter((name) => name.endsWith(".jpg")).length).toBeGreaterThan(applied + 1);
      await page.getByRole("button", { name: "Stop recording", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Recording folder" })).toHaveValue(path);
      const done = { path, ...JSON.parse(await readFile(join(path, "recording.json"), "utf8")) as { frames: number; error: string | null } };
      await expect(page.getByText(`Saved ${done.frames} ${done.frames === 1 ? "frame" : "frames"}.`, { exact: true })).toBeVisible();
      expect(done.error).toBeNull();
      const frames = (await readdir(done.path)).filter((name) => name.endsWith(".jpg")).sort();
      expect(frames).toHaveLength(done.frames);
      const brightness: number[] = [];
      for (const frame of frames) brightness.push(await badgeBrightness(page, join(done.path, frame)));
      if (mode === "button") expect(Math.max(...brightness)).toBeGreaterThan(160);
      else expect(Math.max(...brightness)).toBeLessThan(70);
      const summary = await readFile(join(done.path, "recording.json"), "utf8");
      expect(summary).not.toMatch(/synthetic-password|123456|synthetic-shadow|synthetic-closed|Backspace|Enter/);
      await info.attach("recording-oracles", { body: JSON.stringify({ mode, producer: "BrowserPanel image keydown", dispatch: "1:1", brightness, frames: done.frames }), contentType: "application/json" });
      if (mode === "button") await info.attach("recording-controls", { body: await page.screenshot(), contentType: "image/png" });
    } catch (error) { primary = error; }
    try { await service.api("DELETE", endpoint); }
    catch (error) {
      if (!primary) throw error;
      await info.attach("recording-cleanup-error", { body: String(error), contentType: "text/plain" });
    }
    if (primary) throw primary;
  });
}
