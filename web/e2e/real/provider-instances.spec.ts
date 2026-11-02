import { expect, test, type Page } from "@playwright/test";
import { dirname, join, resolve } from "node:path";
import { startProject, type Service } from "./service";

type Instance = { id: string; driver: string; name?: string; program?: string; args?: string[]; enabled: boolean; accent?: string; forward?: unknown };
const executable = join(dirname(process.env.ORBYN_BIN ?? resolve(import.meta.dirname, "../../../target/debug/orbynd")), "orbyn-fake-engine");
const instances = async (service: Service) => (await service.api<{ key: string; value: Instance[] }[]>("GET", "/api/preferences")).find((row) => row.key === "provider_instances")!.value;
const seed = (service: Service, rows: Instance[]) => service.api("PUT", "/api/preferences", { values: { provider_instances: rows } });
const local = (id = "work"): Instance => ({ id, driver: "_local_acp", name: id === "work" ? "Work" : id, program: executable, args: ["acp", "two literal words", ""], enabled: false, forward: { keep: id } });
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

test("Local ACP wizard uses one CAS and retains disabled configuration, literal args and Models", async ({ page }, info) => {
  const { service } = await startProject();
  try {
    const seen = writes(page); await open(page, service);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(seen).toHaveLength(0);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const wizard = page.getByRole("dialog", { name: "Add provider", exact: true });
    await wizard.getByRole("button", { name: "Local ACP command", exact: true }).click();
    await expect(wizard.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
    await wizard.getByRole("textbox", { name: "Executable", exact: true }).fill(executable);
    for (const value of ["acp", "two literal words", ""]) {
      await wizard.getByRole("button", { name: "Add argument", exact: true }).click();
      await wizard.getByRole("textbox", { name: /^Argument / }).last().fill(value);
    }
    await wizard.getByRole("button", { name: "Next", exact: true }).click();
    await wizard.getByRole("textbox", { name: "Label", exact: true }).fill("Browser work");
    const id = await wizard.getByRole("textbox", { name: "Instance ID", exact: true }).inputValue();
    await wizard.getByRole("button", { name: "Add instance", exact: true }).click();
    await expect(wizard).toBeHidden(); expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ scope: {}, if_match: { provider_instances: expect.any(String) }, membership_version: expect.any(String) });
    await expect.poll(() => instances(service)).toContainEqual({ id, driver: "_local_acp", name: "Browser work", program: executable, args: ["acp", "two literal words", ""], enabled: true });
    await expect(page.getByRole("textbox", { name: "Executable", exact: true })).toHaveValue(executable);
    await expect(page.getByRole("textbox", { name: "Argument 2", exact: true })).toHaveValue("two literal words");
    await expect(page.getByRole("button", { name: /^Models \(/ })).toBeVisible();
    await page.getByRole("button", { name: /^Models \(/ }).click();
    await expect(page.getByRole("form", { name: "Custom models for Browser work", exact: true })).toBeVisible();
    const bounds = await page.locator(".provider-argument").evaluateAll((rows) => {
      const container = document.querySelector(".settings-body")!.getBoundingClientRect();
      return rows.map((row) => { const box = row.getBoundingClientRect(); return { left: box.left, right: box.right, min: container.left, max: container.right }; });
    });
    expect(bounds).toHaveLength(3); for (const box of bounds) { expect(box.left).toBeGreaterThanOrEqual(box.min); expect(box.right).toBeLessThanOrEqual(box.max); }
    const engines = await service.api<{ id: string; instance_of?: string; tier: string }[]>("GET", "/api/engines");
    expect(engines).toContainEqual(expect.objectContaining({ id, instance_of: "_local_acp", tier: "acp" }));
    expect(engines.some((engine) => engine.id === "_local_acp")).toBe(false);
    await page.getByRole("switch", { name: "Enable Browser work", exact: true }).click();
    await expect.poll(async () => (await instances(service)).find((row) => row.id === id)?.enabled).toBe(false);
    await expect.poll(async () => (await service.api<{ id: string }[]>("GET", "/api/engines")).some((row) => row.id === id)).toBe(false);
    await expect(page.getByRole("button", { name: "Select Browser work", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Executable", exact: true })).toHaveValue(executable);
    await page.screenshot({ path: info.outputPath("disabled-local-instance.png") });
    await page.getByRole("switch", { name: "Enable Browser work", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Models \(/ })).toBeVisible();
  } finally { await service.stop(); }
});

test("instance name conflicts retain the draft for explicit reload and preserve peers on edit and delete", async ({ page }, info) => {
  const { service } = await startProject();
  try {
    await seed(service, [local(), local("peer")]); const seen = writes(page); await open(page, service);
    await page.getByRole("button", { name: "Select Work", exact: true }).click();
    const external = [ { ...local(), name: "External", forward: { keep: "external" } }, local("peer") ];
    await seed(service, external);
    const name = page.getByRole("textbox", { name: "Display name", exact: true });
    await name.fill("Draft work"); await name.press("Tab");
    await expect(page.getByRole("alert").filter({ hasText: /changed|conflict/i })).toBeVisible();
    await expect(name).toHaveValue("Draft work"); await expect(name).toBeDisabled(); expect(seen).toHaveLength(1);
    expect(await instances(service)).toEqual(external);
    await page.screenshot({ path: info.outputPath("conflict-retains-draft.png") });
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(name).toBeEnabled(); await expect(name).toHaveValue("Draft work"); expect(seen).toHaveLength(1);
    await name.press("Enter");
    await expect.poll(() => instances(service)).toEqual([{ ...external[0], name: "Draft work" }, external[1]]);
    expect(seen).toHaveLength(2);
    await page.getByRole("button", { name: "Delete instance work", exact: true }).click();
    await expect.poll(() => instances(service)).toEqual([local("peer")]); expect(seen).toHaveLength(3);
    await expect(page.getByRole("dialog", { name: /Delete|Remove/ })).toHaveCount(0);
  } finally { await service.stop(); }
});

test("accent picker escapes scrolling settings and supports desktop-dark and narrow-light keyboard editing", async ({ page }, info) => {
  const { service } = await startProject();
  try {
    await seed(service, [local()]); await open(page, service);
    for (const entry of [{ width: 1400, height: 900, theme: "dark" }, { width: 640, height: 760, theme: "light" }]) {
      await page.setViewportSize({ width: entry.width, height: entry.height });
      await page.goto(`${service.page}#/settings/appearance`);
      await page.getByRole("combobox", { name: "Theme", exact: true }).selectOption(entry.theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", entry.theme);
      await open(page, service); await page.getByRole("button", { name: "Select Work", exact: true }).click();
      const trigger = page.getByRole("button", { name: /^(Add|Change) accent color for Work$/ });
      await trigger.click(); const popup = page.getByRole("dialog", { name: "Accent color", exact: true });
      await expect(popup).toBeVisible();
      await expect(page.getByRole("slider", { name: "Accent color saturation", exact: true })).toBeFocused();
      const geometry = await popup.evaluate((element) => {
        const bounds = element.getBoundingClientRect(), hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { topLayer: element.matches(":popover-open"), inside: !!hit && element.contains(hit), left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: innerWidth, height: innerHeight };
      });
      expect(geometry.topLayer).toBe(true); expect(geometry.inside).toBe(true);
      expect(geometry.left).toBeGreaterThanOrEqual(8); expect(geometry.right).toBeLessThanOrEqual(geometry.width - 8);
      expect(geometry.top).toBeGreaterThanOrEqual(8); expect(geometry.bottom).toBeLessThanOrEqual(geometry.height - 8);
      await page.screenshot({ path: info.outputPath(`accent-${entry.width}-${entry.theme}.png`) });
      const hex = popup.getByRole("textbox", { name: "Custom hex accent color", exact: true });
      await hex.fill(entry.theme === "dark" ? "#12abef" : "#efab12");
      await expect.poll(async () => (await instances(service))[0]?.accent).toBe(entry.theme === "dark" ? "#12abef" : "#efab12");
      await page.keyboard.press("Escape"); await expect(popup).toBeHidden(); await expect(trigger).toBeFocused();
    }
  } finally { await service.stop(); }
});

test("a pending accent write keeps Escape owned by the popup and restores focus after its response", async ({ page }) => {
  const { service } = await startProject();
  let release = () => {};
  try {
    await seed(service, [local()]); await open(page, service);
    await page.getByRole("button", { name: "Select Work", exact: true }).click();
    let committed = false, mutations = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/settings/preferences", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      mutations += 1; const response = await route.fetch(); committed = true; await held; await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "Add accent color for Work", exact: true }).click();
    const popup = page.getByRole("dialog", { name: "Accent color", exact: true });
    const hex = popup.getByRole("textbox", { name: "Custom hex accent color", exact: true });
    await hex.fill("#2468ab"); await expect.poll(() => committed).toBe(true); await expect(hex).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden(); await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible(); expect(mutations).toBe(1);
    release();
    const trigger = page.getByRole("button", { name: "Change accent color for Work", exact: true });
    await expect(trigger).toBeEnabled(); await expect(trigger).toBeFocused();
    expect((await instances(service))[0]?.accent).toBe("#2468ab");
  } finally { release(); await service.stop(); }
});
