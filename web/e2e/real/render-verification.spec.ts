import { expect, test } from "@playwright/test";
import { startProject, type Service } from "./service";

let service: Service;
let projectId = "";

const PAGE = `<!doctype html><html><body style="margin:0">
<canvas id="drawing" width="320" height="240"></canvas>
<script>
const canvas = document.getElementById("drawing");
const context = canvas.getContext("2d");
context.fillStyle = "#164e63";
context.fillRect(0, 0, 320, 240);
context.fillStyle = "#fbbf24";
context.fillRect(80, 60, 160, 120);
canvas.dataset.ready = "true";
</script></body></html>`;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({}));
});
test.afterAll(() => service.stop());

test("a published render produces a nonblank screenshot without browser errors", async ({ page, context }, info) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: "codex",
    model: null,
    title: "Render verification",
    worktree: null,
    skill_profile: null,
  });
  const published = await service.api<{ url: string; frame_token: string }>(
    "POST",
    `/api/threads/${thread.id}/renders`,
    { html: PAGE },
  );

  await page.goto(service.page);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(({ url, token }) => {
    const frame = document.createElement("iframe");
    frame.id = "render-verification";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    // Keep the capture above the app shell, whose body deliberately hides overflow.
    frame.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;width:320px;height:240px;border:0;display:block";
    frame.src = `${url}?render=${token}`;
    document.body.append(frame);
  }, { url: published.url, token: published.frame_token });

  const frame = page.locator("#render-verification");
  await expect(page.frameLocator("#render-verification").locator("#drawing")).toHaveAttribute("data-ready", "true");
  const screenshot = await frame.screenshot({ scale: "css" });
  await info.attach("render-verification.png", { body: screenshot, contentType: "image/png" });

  // Decode the captured PNG in a fresh browser page, not the source canvas.
  const decoder = await context.newPage();
  try {
    const image = await decoder.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const drawing = canvas.getContext("2d");
      if (!drawing) throw new Error("Could not decode screenshot pixels");
      drawing.drawImage(bitmap, 0, 0);
      const pixel = (x: number, y: number) => Array.from(drawing.getImageData(x, y, 1, 1).data);
      return { width: bitmap.width, height: bitmap.height, background: pixel(20, 20), shape: pixel(160, 120), opposite: pixel(300, 220) };
    }, Array.from(screenshot));
    expect([image.width, image.height]).toEqual([320, 240]);
    expect(image.background).toEqual([22, 78, 99, 255]);
    expect(image.opposite).toEqual(image.background);
    expect(image.shape).toEqual([251, 191, 36, 255]);
    expect(image.shape).not.toEqual(image.background);
    expect(errors).toEqual([]);
  } finally {
    await decoder.close();
  }
});
