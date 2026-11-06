import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startProject, type Service } from "./service";

/** Claude's own skills reach the composer's `$` menu through the real service. */

let service: Service;
let projectId = "";

const box = (page: Page) => page.getByRole("textbox", { name: /^Message/ });

function skill(root: string, name: string, description: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ fakeEngines: true }));
  // The service runs with CLAUDE_CONFIG_DIR at a folder of its own.
  const config = join(dirname(service.dataDir), "claude");
  skill(join(config, "skills"), "config-skill", "From the config dir");
  skill(join(service.repo, ".claude/skills"), "project-skill", "From the checkout");

  const plugin = join(config, "plugins/cache/demo/1.0.0");
  skill(join(plugin, "skills"), "plugin-skill", "From a plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), '{"name":"demo"}\n');
  writeFileSync(
    join(config, "plugins/installed_plugins.json"),
    JSON.stringify({ plugins: { "demo@market": [{ scope: "user", installPath: plugin }] } }),
  );
  writeFileSync(join(config, "settings.json"), '{"enabledPlugins":{"demo@market":true}}\n');
});
test.afterAll(() => service.stop());
test.beforeEach(({ page }) => page.setViewportSize({ width: 1400, height: 900 }));

test("the $ menu offers config, checkout and plugin skills", async ({ page }) => {
  const thread = await service.api<{ id: string }>("POST", "/api/threads", {
    project_id: projectId,
    engine: "claude",
    model: null,
    title: "Skills",
    worktree: null,
    skill_profile: null,
  });
  await page.goto(`${service.page}#/threads/${thread.id}`);

  await box(page).pressSequentially("$config");
  await expect(page.getByRole("option", { name: "$config-skill" })).toBeVisible();
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("$config-skill ");

  await box(page).fill("");
  await box(page).pressSequentially("$demo:plugin");
  await expect(page.getByRole("option", { name: "$demo:plugin-skill" })).toBeVisible();
  await box(page).press("Enter");
  await expect(box(page)).toHaveValue("$demo:plugin-skill ");
});
