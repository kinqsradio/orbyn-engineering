import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "orbyn.prefs.v1";

/** A fresh load of the store, as a page reload would give. */
async function load() {
  vi.resetModules();
  return (await import("./ui")).useUi;
}
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;

beforeEach(() => localStorage.clear());

describe("saved-preference migration", () => {
  it("moves the old default width and turns folders on, once", async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 208, projectFolders: false }));
    const first = await load();
    expect(first.getState().sidebarWidth).toBe(224);
    expect(first.getState().projectFolders).toBe(true);
    expect(first.getState().foldersNotice).toBe(true);
    expect(saved().prefsVersion).toBe(1);

    // The person turns it off by hand; a later load must not turn it on again.
    localStorage.setItem(KEY, JSON.stringify({ ...saved(), projectFolders: false }));
    const second = await load();
    expect(second.getState().projectFolders).toBe(false);
    expect(second.getState().foldersNotice).toBe(false);
  });

  it("leaves a custom width alone", async () => {
    localStorage.setItem(KEY, JSON.stringify({ sidebarWidth: 260 }));
    const ui = await load();
    expect(ui.getState().sidebarWidth).toBe(260);
    expect(ui.getState().projectFolders).toBe(true);
  });

  it("does not announce itself on a first run", async () => {
    const ui = await load();
    expect(ui.getState().foldersNotice).toBe(false);
    expect(ui.getState().sidebarWidth).toBe(224);
    expect(saved().prefsVersion).toBe(1);
  });

  it("Turn off sticks after a reload", async () => {
    localStorage.setItem(KEY, JSON.stringify({ projectFolders: false }));
    const first = await load();
    expect(first.getState().foldersNotice).toBe(true);
    first.getState().closeFoldersNotice(true);
    expect(first.getState().foldersNotice).toBe(false);
    expect(first.getState().projectFolders).toBe(false);
    const reloaded = await load();
    expect(reloaded.getState().projectFolders).toBe(false);
    expect(reloaded.getState().foldersNotice).toBe(false);
  });
});
