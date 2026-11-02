import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startProject } from "./service";

const executable = join(dirname(process.env.ORBYN_BIN ?? resolve(import.meta.dirname, "../../../target/debug/orbynd")), "orbyn-fake-engine");
const history = (kind: string, text: string) => ({ sessionUpdate: kind, content: { type: "text", text } });
const row = (sessionId: string, cwd: string, title: string) => ({ sessionId, cwd, title, history: [history("user_message_chunk", "saved question"), history("agent_message_chunk", "saved answer")] });

test("an ACP agent's saved sessions are listed, imported and deleted from Settings", async ({ page }, info) => {
  const native = mkdtempSync(join(tmpdir(), "orbyn-native-"));
  const { service } = await startProject({ nativeSessions: native });
  try {
    const [project] = await service.api<{ path: string }[]>("GET", "/api/projects");
    writeFileSync(join(native, "sessions.json"), JSON.stringify([row("a1", project!.path, "Alpha chat"), row("b2", project!.path, "Beta chat"), row("c3", project!.path, "Gamma chat"), row("z9", "/not/this/project", "Elsewhere")]));
    await service.api("PUT", "/api/preferences", { values: { provider_instances: [{ id: "agent", driver: "_local_acp", name: "Saved agent", program: executable, args: ["acp"] }] } });
    await page.goto(`${service.page}#/settings/providers`);
    await page.getByRole("button", { name: "Select Saved agent", exact: true }).click();
    await page.getByRole("button", { name: "List sessions", exact: true }).click();
    await expect(page.getByText("Alpha chat")).toBeVisible();
    await expect(page.getByText("Beta chat")).toBeVisible();
    await expect(page.getByText("Gamma chat")).toHaveCount(0);
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.getByText("Gamma chat")).toBeVisible();
    await expect(page.getByText("Elsewhere")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("native-sessions.png") });

    const alpha = page.getByRole("listitem").filter({ hasText: "Alpha chat" });
    await alpha.getByRole("button", { name: "Import", exact: true }).click();
    await expect(alpha.getByRole("button", { name: "Imported", exact: true })).toBeDisabled();
    await expect(alpha.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    const threads = await service.api<{ id: string; title: string; engine: string }[]>("GET", "/api/threads");
    expect(threads.filter((thread) => thread.engine === "agent").map((thread) => thread.title)).toEqual(["Alpha chat"]);

    const beta = page.getByRole("listitem").filter({ hasText: "Beta chat" });
    await beta.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator("footer").getByRole("button", { name: "Cancel", exact: true }).click();
    expect(readFileSync(join(native, "sessions.json"), "utf8")).toContain("b2");
    await beta.getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator("footer").getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Beta chat")).toHaveCount(0);
    expect(readFileSync(join(native, "sessions.json"), "utf8")).not.toContain("b2");
    expect(readFileSync(join(native, "sessions.json"), "utf8")).toContain("a1");
  } finally { await service.stop(); }
});

test("an agent that cannot list sessions shows no session controls", async ({ page }) => {
  const { service } = await startProject();
  try {
    await service.api("PUT", "/api/preferences", { values: { provider_instances: [{ id: "plain", driver: "_local_acp", name: "Plain agent", program: executable, args: ["acp"] }] } });
    await page.goto(`${service.page}#/settings/providers`);
    await page.getByRole("button", { name: "Select Plain agent", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Models \(/ })).toBeVisible();
    await expect(page.getByText("Native sessions")).toHaveCount(0);
  } finally { await service.stop(); }
});
