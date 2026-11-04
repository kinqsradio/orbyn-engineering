import { expect, test } from "@playwright/test";
import { startProject, type Service } from "./service";

/**
 * The sandbox and the page policy together, watched from a real browser: a
 * published page may draw itself, and it must not reach the API, this origin's
 * storage or the page around it. The rest of the row is covered by the Rust tests
 * (`crates/orbynd/tests/renders.rs`, `agent_tools.rs`) and by vitest; this is the
 * half that only a browser can answer.
 */

let service: Service;
let projectId = "";

const PROBE = `<!doctype html><title>probe</title><body style="margin:0">
<div id="out">pending</div>
<script>
(async () => {
  let api = "ok";
  try {
    const response = await fetch("/api/settings");
    api = "status " + response.status;
  } catch (error) {
    api = "blocked";
  }
  // A sandboxed document without allow-same-origin throws on this property.
  let cookie = "read";
  try {
    cookie = document.cookie ? "present" : "empty";
  } catch (error) {
    cookie = "refused";
  }
  let parent = "reached";
  try {
    parent = window.parent.document.title ? "reached" : "empty";
  } catch (error) {
    parent = "blocked";
  }
  // window.origin is "null" for an opaque origin; location.origin still names
  // the address the frame was fetched from, so it proves nothing on its own.
  document.getElementById("out").textContent =
    "origin=" + window.origin + " cookie=" + cookie + " api=" + api + " parent=" + parent;
})();
</script></body>`;

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({}));
});
test.afterAll(() => service.stop());

test("a published page runs, and reaches neither the API nor this app", async ({ page }) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: "codex",
    model: null,
    title: "Renders",
    worktree: null,
    skill_profile: null,
  });
  const published = await service.api<{ id: string; url: string; frame_token: string }>(
    "POST",
    `/api/threads/${thread.id}/renders`,
    { html: PROBE },
  );
  expect(published.frame_token).toMatch(/^[0-9a-f]{64}$/);

  await page.goto(service.page);
  // The frame the product draws: sandboxed without allow-same-origin, so the page
  // gets an opaque origin, and its token is scoped to this one render.
  await page.evaluate(
    ({ url, token }) => {
      const frame = document.createElement("iframe");
      frame.id = "probe";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = `${url}?render=${token}`;
      document.body.append(frame);
    },
    { url: published.url, token: published.frame_token },
  );

  const inside = page.frameLocator("#probe");
  await expect(inside.locator("#out")).not.toHaveText("pending", { timeout: 15_000 });
  const result = (await inside.locator("#out").textContent()) ?? "";
  // The script ran, so the page is a real one, not a blank document.
  // It ran in an opaque origin, could not read our cookies, could not reach the
  // API through the page policy, and could not see the app around it.
  expect(result).toContain("origin=null");
  expect(result).toContain("cookie=refused");
  expect(result).toContain("api=blocked");
  expect(result).toContain("parent=blocked");

  // The served page carries the policy that did all of that.
  const served = await page.request.get(`${service.url}${published.url}?render=${published.frame_token}`);
  expect(served.status()).toBe(200);
  const policy = served.headers()["content-security-policy"] ?? "";
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("script-src 'unsafe-inline'");
  expect(policy).not.toContain("connect-src");
  expect(policy).not.toContain("allow-same-origin");

  // Without the render token, and with a wrong one, the page is refused.
  expect((await page.request.get(`${service.url}${published.url}`)).status()).toBe(401);
  expect((await page.request.get(`${service.url}${published.url}?render=${"0".repeat(64)}`)).status()).toBe(401);
});