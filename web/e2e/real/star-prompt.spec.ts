import { expect, test } from "@playwright/test";
import { send, settled, startService } from "./service";

for (const { starred, close } of [{ starred: false, close: "button" }, { starred: false, close: "swipe" }, { starred: true, close: "none" }]) {
  test(`six real-service sends: ${starred ? "existing star" : close + " dismissal"}`, async ({ page }, info) => {
    const service = await startService({ fakeEngines: true, forge: true, starred });
    try {
      await service.api("POST", "/api/workspace/setup", {});
      const project = await service.api<{ id: string }>("POST", "/api/projects/create", { name: "star-fixture", readme: true });
      await service.api("POST", `/api/projects/${project.id}/trust`, {});
      const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: project.id, engine: "codex", model: null, title: "Star fixture", worktree: null, skill_profile: null });
      await page.goto(`${service.page}#/threads/${thread.id}`);
      const notice = page.getByRole("group", { name: "Enjoying Orbyn Engineering?", exact: true });
      for (let index = 0; index < 5; index++) {
        await send(page, `star fixture ${index}`); await settled(service, thread.id);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
      }
      await expect(notice).toHaveCount(0);
      await send(page, "sixth successful prompt"); await settled(service, thread.id);
      await expect.poll(() => service.ghCalls().filter((args) => args.includes("user/starred/kinqsradio/orbyn-engineering")).length).toBe(1);
      if (starred) {
        await expect.poll(() => page.evaluate(() => localStorage.getItem("orbyn:github-star:dismissed"))).toBe("true");
        await expect(notice).toHaveCount(0);
      } else {
        await expect(notice).toBeVisible();
        await expect(notice.getByRole("link", { name: "Star on GitHub", exact: true })).toHaveAttribute("href", "https://github.com/kinqsradio/orbyn-engineering");
        await page.screenshot({ path: info.outputPath("star-prompt.png") });
        if (close === "swipe") {
          const bounds = (await notice.boundingBox())!;
          await page.mouse.move(bounds.x + 24, bounds.y + 20);
          await page.mouse.down();
          await page.mouse.move(bounds.x + 174, bounds.y + 20, { steps: 8 });
          await page.mouse.up();
        } else await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
        await expect(notice).toHaveCount(0);
      }
      await page.reload();
      await send(page, "after a fresh page session"); await settled(service, thread.id);
      await expect(notice).toHaveCount(0);
      expect(service.ghCalls().filter((args) => args.includes("user/starred/kinqsradio/orbyn-engineering"))).toHaveLength(1);
      expect(service.ghCalls().filter((args) => args.includes("PUT") || args.includes("POST")).some((args) => args.some((arg) => arg.startsWith("user/starred/")))).toBe(false);
    } finally { await service.stop(); }
  });
}
