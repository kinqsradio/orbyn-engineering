import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const serviceSource = readFileSync(new URL("../../crates/orbynd/src/ui.rs", import.meta.url), "utf8");
const servicePolicy = serviceSource.match(/const CSP: &str = "([\s\S]*?)";/)?.[1]
  ?.replace(/\\\r?\n\s*/g, "");
if (!servicePolicy) throw new Error("Missing service CSP");
const desktop = JSON.parse(readFileSync(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const policies: Record<string, string> = { service: servicePolicy, desktop: desktop.app.security.csp };

for (const [name, policy] of Object.entries(policies)) {
  test(`${name} policy loads proxied images and refuses direct remote resources`, async ({ page, baseURL }) => {
    // The dev server's own origin, whatever port the run was given.
    const origin = new URL(baseURL ?? "http://localhost:5274").origin;
    const requested: string[] = [];
    await page.route("https://media.example/**", async (route) => {
      requested.push(route.request().url());
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" />' });
    });
    await page.route("http://media.example/**", async (route) => {
      requested.push(route.request().url());
      await route.abort();
    });
    await page.route(`${origin}/api/media/image?**`, (route) => route.fulfill({
      contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" />',
    }));
    // Use the two production policies, with no Vite development-policy substitution.
    await page.route(`${origin}/policy-probe`, (route) => route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": policy },
      body: '<!doctype html><img id="proxied" src="/api/media/image?url=https%3A%2F%2Fmedia.example%2Fimage.png"><img id="secure" src="https://media.example/image.svg"><img id="insecure" src="http://media.example/image.svg"><video src="https://media.example/video.mp4" preload="auto"></video><iframe src="https://media.example/frame"></iframe><script src="https://media.example/script.js"></script>',
    }));
    await page.goto("/policy-probe");
    await expect(page.locator("#proxied")).toHaveJSProperty("naturalWidth", 2);
    await expect(page.locator("#secure")).toHaveJSProperty("naturalWidth", 0);
    await expect(page.locator("#insecure")).toHaveJSProperty("naturalWidth", 0);
    expect(await page.evaluate(async () => {
      try { await fetch("https://media.example/api"); return "allowed"; }
      catch { return "blocked"; }
    })).toBe("blocked");
    expect(requested).toEqual([]);
    const directives = policy.split(";").map((value) => value.trim());
    expect(directives.find((value) => value.startsWith("script-src "))).toBe("script-src 'self'");
    expect(directives.find((value) => value.startsWith("connect-src "))).toBe(name === "service"
      ? "connect-src 'self'" : "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*");
  });
}
