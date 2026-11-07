import { expect, test, type Page } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { startProject, type Service } from "./service";

/** The arguments line the editor shows: whitespace separates arguments and quotes keep one together. */
const formatArgs = (list: string[]) => list.map((arg) => (arg === "" || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");

type Instance = { id: string; driver: string; name?: string; program?: string; args?: string[]; enabled: boolean; accent?: string; forward?: unknown };
const executable = join(dirname(process.env.ORBYN_BIN ?? resolve(import.meta.dirname, "../../../target/debug/orbynd")), "orbyn-fake-engine");
const instances = async (service: Service) => (await service.api<{ key: string; value: Instance[] }[]>("GET", "/api/preferences")).find((row) => row.key === "provider_instances")!.value;
const seed = (service: Service, rows: Instance[]) => service.api("PUT", "/api/preferences", { values: { provider_instances: rows } });
const local = (id = "work"): Instance => ({ id, driver: "_local_acp", name: id === "work" ? "Work" : id, program: executable, args: ["acp", "two literal words", ""], enabled: true, forward: { keep: id } });
const args = formatArgs(["acp", "two literal words", ""]);
const open = async (page: Page, service: Service) => {
  await page.goto(`${service.page}#/settings/providers`);
  await expect(page.getByRole("button", { name: "Add provider", exact: true })).toBeEnabled();
};
function writes(page: Page) {
  const seen: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings/preferences") {
      const body = request.postDataJSON(); if (body.edits?.provider_instances) seen.push(body);
    }
  });
  return seen;
}

const disabledEngines = async (service: Service) => (await service.api<{ key: string; value: string[] }[]>("GET", "/api/preferences")).find((row) => row.key === "disabled_engines")!.value;
const edit = (page: Page, name: string) => page.getByRole("button", { name: `Edit ${name}`, exact: true });

test("Local ACP command is added with one CAS, keeps literal args and Models, and stays when turned off", async ({ page }, info) => {
  const { service } = await startProject();
  try {
    const seen = writes(page); await open(page, service);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("dialog", { name: "Add a provider", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click(); expect(seen).toHaveLength(0);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const chooser = page.getByRole("dialog", { name: "Add a provider", exact: true });
    await chooser.getByRole("radio", { name: /A local ACP command/ }).check();
    await chooser.getByRole("button", { name: "Continue", exact: true }).click();
    const wizard = page.getByRole("dialog", { name: "Add a local ACP command", exact: true });
    await expect(wizard.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await wizard.getByRole("textbox", { name: "Executable", exact: true }).fill(executable);
    await wizard.getByRole("textbox", { name: "Arguments", exact: true }).fill(args);
    await expect(wizard.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await wizard.getByRole("textbox", { name: "Display name", exact: true }).fill("Browser work");
    await wizard.getByRole("button", { name: "Save", exact: true }).click();
    await expect(wizard).toBeHidden(); expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ scope: {}, if_match: { provider_instances: expect.any(String) }, membership_version: expect.any(String) });
    await expect.poll(async () => (await instances(service)).length).toBe(1);
    const id = (await instances(service))[0]!.id;
    expect((await instances(service))[0]).toEqual({ id, driver: "_local_acp", name: "Browser work", program: executable, args: ["acp", "two literal words", ""], enabled: true });
    await expect(page.getByRole("heading", { name: "Browser work", exact: true })).toBeVisible();
    await expect(page.getByText("Models", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add custom model", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Add custom model", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", { name: /^Edit / });
    await expect(editor.getByRole("textbox", { name: "Executable", exact: true })).toHaveValue(executable);
    await expect(editor.getByRole("textbox", { name: "Arguments", exact: true })).toHaveValue(args);
    const bounds = await editor.evaluate((dialog) => {
      const box = dialog.getBoundingClientRect(), field = dialog.querySelector("#instance-args")!.getBoundingClientRect();
      return { left: field.left >= box.left, right: field.right <= box.right };
    });
    expect(bounds).toEqual({ left: true, right: true });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    const engines = await service.api<{ id: string; instance_of?: string; tier: string }[]>("GET", "/api/engines");
    expect(engines).toContainEqual(expect.objectContaining({ id, instance_of: "_local_acp", tier: "acp" }));
    expect(engines.some((engine) => engine.id === "_local_acp")).toBe(false);
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByRole("switch", { name: "Use Browser work", exact: true }).click();
    await expect.poll(() => disabledEngines(service)).toContain(id);
    expect((await instances(service))[0]).toMatchObject({ id, program: executable, args: ["acp", "two literal words", ""] });
    await expect(page.getByRole("button", { name: "Browser work", exact: true })).toBeVisible();
    await edit(page, "Browser work").click();
    await expect(page.getByRole("textbox", { name: "Executable", exact: true })).toHaveValue(executable);
    await page.screenshot({ path: info.outputPath("turned-off-local-instance.png") });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("switch", { name: "Use Browser work", exact: true }).click();
    await expect.poll(() => disabledEngines(service)).not.toContain(id);
  } finally { await service.stop(); }
});

test("instance name conflicts retain the draft until Reload and preserve peers on edit and remove", async ({ page }, info) => {
  const { service } = await startProject();
  try {
    await seed(service, [local(), local("peer")]); const seen = writes(page); await open(page, service);
    await edit(page, "Work").click();
    const external = [ { ...local(), name: "External", forward: { keep: "external" } }, local("peer") ];
    await seed(service, external);
    const dialog = page.getByRole("dialog", { name: /^Edit / });
    const name = dialog.getByRole("textbox", { name: "Display name", exact: true });
    await name.fill("Draft work");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText(/changed|conflict/i);
    await expect(name).toHaveValue("Draft work"); await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled(); expect(seen).toHaveLength(1);
    expect(await instances(service)).toEqual(external);
    await page.screenshot({ path: info.outputPath("conflict-retains-draft.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const reloaded = page.waitForResponse((response) => response.url().endsWith("/api/settings/preferences/query"));
    await page.getByRole("button", { name: "Reload", exact: true }).click(); await reloaded;
    await page.getByRole("button", { name: /^Edit (Work|External)$/ }).click();
    await expect(name).toHaveValue("External");
    await name.fill("Draft work");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => instances(service)).toEqual([{ ...external[0], name: "Draft work" }, external[1]]);
    expect(seen).toHaveLength(2);
    await page.getByRole("button", { name: "Draft work", exact: true }).click();
    await page.getByRole("button", { name: "Remove Draft work", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove Draft work?" }).getByRole("button", { name: "Remove provider", exact: true }).click();
    await expect.poll(() => instances(service)).toEqual([local("peer")]); expect(seen).toHaveLength(3);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { await service.stop(); }
});

test("colour swatches stay inside the dialog on desktop-dark and narrow-light and are keyboard operable", async ({ page }, info) => {
  const { service } = await startProject();
  try {
    await seed(service, [local()]); await open(page, service);
    for (const entry of [{ width: 1400, height: 900, theme: "dark" }, { width: 640, height: 760, theme: "light" }]) {
      await page.setViewportSize({ width: entry.width, height: entry.height });
      await page.goto(`${service.page}#/settings/appearance`);
      await page.getByRole("radiogroup", { name: "Theme", exact: true }).getByRole("radio", { name: entry.theme === "dark" ? "Dark" : "Light", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", entry.theme);
      await open(page, service);
      const trigger = edit(page, "Work"); await trigger.click();
      const dialog = page.getByRole("dialog", { name: /^Edit / });
      await expect(dialog).toBeVisible();
      const swatches = dialog.getByRole("group", { name: "Colour", exact: true }).getByRole("button");
      const geometry = await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const inside = [...element.querySelectorAll(".swatch")].every((swatch) => {
          const box = swatch.getBoundingClientRect(); return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
        return { topLayer: element.matches(":modal"), inside, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight };
      });
      expect(geometry.topLayer).toBe(true); expect(geometry.inside).toBe(true);
      expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      await page.screenshot({ path: info.outputPath(`accent-${entry.width}-${entry.theme}.png`) });
      const pick = swatches.nth(entry.theme === "dark" ? 3 : 1);
      const colour = (await pick.getAttribute("aria-label"))!.replace("Colour ", "");
      await pick.focus(); await page.keyboard.press("Enter");
      await expect(pick).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(async () => (await instances(service))[0]?.accent).toBe(colour);
      await expect(trigger).toBeFocused();
      await trigger.click(); await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    }
  } finally { await service.stop(); }
});

test("a pending save keeps Escape from closing the dialog and restores focus after its response", async ({ page }) => {
  const { service } = await startProject();
  let release = () => {};
  try {
    await seed(service, [local()]); await open(page, service);
    const trigger = edit(page, "Work"); await trigger.click();
    const dialog = page.getByRole("dialog", { name: /^Edit / });
    let committed = false, mutations = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/settings/preferences", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      mutations += 1; const response = await route.fetch(); committed = true; await held; await route.fulfill({ response });
    });
    await dialog.getByRole("group", { name: "Colour", exact: true }).getByRole("button").nth(4).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible(); expect(mutations).toBe(1);
    release();
    await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    expect((await instances(service))[0]?.accent).toBe("#a855f7");
  } finally { release(); await service.stop(); }
});
