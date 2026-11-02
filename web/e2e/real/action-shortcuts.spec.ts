import { expect, test } from "@playwright/test";
import { projectSettingsUrl, startProject } from "./service";
import { writeFileSync } from "node:fs";

test("an action shortcut survives rename and can be cleared", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  const heldReads: (() => void)[] = [];
  try {
    await page.goto(await projectSettingsUrl(service, projectId));
    const settings = page.locator(".settings-body");
    await settings.getByRole("button", { name: "Add action", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add Action", exact: true });
    await form.getByLabel("Name", { exact: true }).fill("Shortcut action");
    await form.getByLabel("Command", { exact: true }).fill("echo shortcut-action-output");
    await expect(form.getByLabel("Keybinding", { exact: true })).toBeEnabled();
    await form.getByLabel("Keybinding", { exact: true }).press("Control+Alt+k");
    await form.getByRole("button", { name: "Save action", exact: true }).click();
    await expect(form).toHaveCount(0);
    const preferences = await service.api<{ key: string; value: { id: string; name: string }[] }[]>("GET", `/api/preferences?project_id=${projectId}`);
    const action = preferences.find((entry) => entry.key === "default_project_scripts")!.value[0]!;
    const command = `script.${action.id}.run`;
    const bound = async () => (await service.api<{ rules: { key: string; command: string }[] }>("GET", "/api/keybindings")).rules.filter((rule) => rule.command === command);
    await expect.poll(bound).toHaveLength(1);
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Shortcut fixture" });
    const base = `/api/threads/${thread.id}`;
    const catalogRoute = `**/api/threads/${thread.id}/scripts`;
    let holdCatalog = true;
    let pendingReads = 0;
    await page.route(catalogRoute, async (route) => {
      pendingReads += 1;
      try {
        if (route.request().method() === "GET" && holdCatalog) await new Promise<void>((resolve) => heldReads.push(resolve));
        if (!route.request().failure()) await route.continue();
      } finally { pendingReads -= 1; }
    });
    const output = async (name: string) => {
      const terminal = (await service.api<{ id: string; script: string | null }[]>("GET", `${base}/terminals`)).find((entry) => entry.script === name);
      return terminal ? (await service.api<{ text: string }>("GET", `${base}/terminals/${terminal.id}/scrollback`)).text : "";
    };
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await expect(page.getByRole("heading", { name: "Shortcut fixture", exact: true })).toBeVisible();
    await expect.poll(() => heldReads.length).toBeGreaterThan(0);
    holdCatalog = false;
    await page.keyboard.press("Control+Alt+k");
    await expect.poll(() => output("Shortcut action")).toContain("shortcut-action-output");
    for (const release of heldReads.splice(0)) release();
    await expect.poll(() => pendingReads).toBe(0);
    await page.unroute(catalogRoute);
    await expect(page.getByRole("tab", { name: "Shortcut action", exact: true })).toHaveAttribute("aria-selected", "true");
    const createdAt = async () => (await service.api<{ script: string | null; created_at: string }[]>("GET", `${base}/terminals`))
      .find((terminal) => terminal.script === "Shortcut action")?.created_at;
    const firstStart = await createdAt();
    await page.locator(".terminal-drawer-body .xterm-helper-textarea").first().focus();
    await page.keyboard.press("Control+Alt+k");
    await expect.poll(createdAt).not.toBe(firstStart);
    await expect.poll(() => output("Shortcut action")).toContain("shortcut-action-output");
    await page.goto(await projectSettingsUrl(service, projectId));
    await settings.getByRole("button", { name: "Edit Shortcut action", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Action", exact: true });
    await expect(edit.getByLabel("Keybinding", { exact: true })).not.toHaveValue("");
    await edit.getByLabel("Name", { exact: true }).fill("Renamed shortcut");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await expect(page.getByRole("heading", { name: "Shortcut fixture", exact: true })).toBeVisible();
    await page.keyboard.press("Control+Alt+k");
    await expect.poll(() => output("Renamed shortcut")).toContain("shortcut-action-output");
    await expect(page.getByRole("tab", { name: "Renamed shortcut", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.goto(await projectSettingsUrl(service, projectId));
    await settings.getByRole("button", { name: "Edit Renamed shortcut", exact: true }).click();
    await expect(edit.getByLabel("Keybinding", { exact: true })).toBeEnabled();
    await expect(edit.getByLabel("Keybinding", { exact: true })).not.toHaveValue("");
    await edit.getByLabel("Keybinding", { exact: true }).press("Backspace");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect.poll(bound).toEqual([]);
  } finally {
    for (const release of heldReads.splice(0)) release();
    await service.stop();
  }
});

test("a shortcut-file failure retains the saved action and retries without creating a duplicate", async ({ page }) => {
  const { service, projectId } = await startProject({ fakeEngines: true });
  try {
    const keymap = await service.api<{ path: string }>("GET", "/api/keybindings");
    expect(keymap.path.startsWith(service.dataDir)).toBe(true);
    await page.goto(await projectSettingsUrl(service, projectId));
    const settings = page.locator(".settings-body");
    await settings.getByRole("button", { name: "Add action", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add Action", exact: true });
    await add.getByLabel("Name", { exact: true }).fill("Retained action");
    await add.getByLabel("Command", { exact: true }).fill("echo retained-action");
    await expect(add.getByLabel("Keybinding", { exact: true })).toBeEnabled();
    await add.getByLabel("Keybinding", { exact: true }).press("Control+Alt+k");
    writeFileSync(keymap.path, "{invalid fixture keymap");
    await add.getByRole("button", { name: "Save action", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit Action", exact: true });
    await expect(edit.getByRole("alert")).toContainText("Action saved.");
    await expect(edit.getByRole("alert")).toContainText("Fix the keybindings file");
    await expect(edit.getByLabel("Keybinding", { exact: true })).not.toHaveValue("");
    const actions = async () => (await service.api<{ key: string; value: { id: string; name: string }[] }[]>("GET", `/api/preferences?project_id=${projectId}`))
      .find((entry) => entry.key === "default_project_scripts")!.value;
    const saved = await actions();
    expect(saved).toHaveLength(1);
    writeFileSync(keymap.path, "[]");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(edit).toHaveCount(0);
    expect(await actions()).toEqual(saved);
    const bindings = await service.api<{ rules: { command: string }[] }>("GET", "/api/keybindings");
    expect(bindings.rules.filter((rule) => rule.command === `script.${saved[0]!.id}.run`)).toHaveLength(1);
  } finally { await service.stop(); }
});

test("terminal input and pending action shortcuts share keyboard ownership", async ({ page }) => {
  const { service, projectId } = await startProject();
  const heldReads: (() => void)[] = [];
  try {
    await service.api("PUT", `/api/projects/${projectId}/preferences`, { values: { default_project_scripts: [
      { id: "bare-action", name: "Bare action", command: "echo bare-action-ran" },
      { id: "pending-action", name: "Pending action", command: "echo pending-action-ran" },
    ] } });
    await service.api("POST", "/api/keybindings", { key: "k", command: "script.bare-action.run" });
    await service.api("POST", "/api/keybindings", { key: "ctrl+alt+k", command: "script.pending-action.run", when: "terminalFocus && !turnRunning" });
    const thread = await service.api<{ id: string }>("POST", "/api/threads", { project_id: projectId, engine: "codex", title: "Terminal shortcut ownership" });
    const base = `/api/threads/${thread.id}`;
    const catalogRoute = `**${base}/scripts`;
    let holdCatalog = true;
    let pendingReads = 0;
    await page.route(catalogRoute, async (route) => {
      pendingReads += 1;
      try {
        if (route.request().method() === "GET" && holdCatalog) await new Promise<void>((resolve) => heldReads.push(resolve));
        if (!route.request().failure()) await route.continue();
      } finally { pendingReads -= 1; }
    });
    await page.goto(`${service.page}#/threads/${thread.id}`);
    await expect(page.getByRole("heading", { name: "Terminal shortcut ownership", exact: true })).toBeVisible();
    await expect.poll(() => heldReads.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    const input = page.locator(".terminal-drawer-body .xterm-helper-textarea").first();
    const terminals = () => service.api<{ id: string; script: string | null }[]>("GET", `${base}/terminals`);
    const mainOutput = async () => {
      const main = (await terminals()).find((terminal) => terminal.id === "main");
      return main ? (await service.api<{ text: string }>("GET", `${base}/terminals/${main.id}/scrollback`)).text : "";
    };
    // Wait for shell input to work before testing ownership of its modified key.
    await expect(async () => {
      await input.focus();
      await page.keyboard.type("echo shell-ready\n");
      await expect.poll(mainOutput, { timeout: 2000 }).toContain("shell-ready");
    }).toPass();
    holdCatalog = false;
    await input.focus();
    await page.keyboard.press("Control+Alt+k");
    await expect.poll(async () => (await terminals()).some((terminal) => terminal.script === "Pending action")).toBe(true);
    for (const release of heldReads.splice(0)) release();
    await expect.poll(() => pendingReads).toBe(0);
    await page.unroute(catalogRoute);
    await expect(page.getByRole("tab", { name: "Pending action", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await input.focus();
    await page.keyboard.type("echo shortcut-input-kept\n");
    await expect.poll(mainOutput).toContain("shortcut-input-kept");
    expect((await terminals()).some((terminal) => terminal.script === "Bare action")).toBe(false);
  } finally {
    for (const release of heldReads.splice(0)) release();
    await service.stop();
  }
});
