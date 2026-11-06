import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "orbyn.prefs.v1";
const MARKER = "orbyn.prefs.migrated";

/** A fresh load of the store, as a page reload would give. */
async function load() {
  vi.resetModules();
  return (await import("./ui")).useUi;
}
const saved = () => JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
const put = (value: unknown) => localStorage.setItem(KEY, JSON.stringify(value));

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("saved-preference migration", () => {
  it("moves the old default width and turns folders on, once", async () => {
    put({ sidebarWidth: 208, projectFolders: false });
    const first = await load();
    expect(first.getState().sidebarWidth).toBe(224);
    expect(first.getState().projectFolders).toBe(true);
    expect(first.getState().foldersNotice).toBe(true);
    expect(localStorage.getItem(MARKER)).toBe("1");

    // The person turns it off by hand; a later load must not turn it on again.
    put({ ...saved(), projectFolders: false });
    const second = await load();
    expect(second.getState().projectFolders).toBe(false);
    expect(second.getState().foldersNotice).toBe(false);
  });

  it("leaves a custom width alone", async () => {
    put({ sidebarWidth: 260 });
    const ui = await load();
    expect(ui.getState().sidebarWidth).toBe(260);
    expect(ui.getState().projectFolders).toBe(true);
  });

  it("migrates a 208 width silently when folders were already on", async () => {
    put({ sidebarWidth: 208, projectFolders: true });
    const ui = await load();
    expect(ui.getState().sidebarWidth).toBe(224);
    expect(ui.getState().foldersNotice).toBe(false);
  });

  it("keeps a 208 width once the migration has run", async () => {
    localStorage.setItem(MARKER, "1");
    put({ sidebarWidth: 208, projectFolders: false });
    const ui = await load();
    expect(ui.getState().sidebarWidth).toBe(208);
    expect(ui.getState().projectFolders).toBe(false);
    expect(ui.getState().foldersNotice).toBe(false);
  });

  it("does not announce itself on a first run", async () => {
    const ui = await load();
    expect(ui.getState().foldersNotice).toBe(false);
    expect(ui.getState().sidebarWidth).toBe(224);
    expect(localStorage.getItem(MARKER)).toBe("1");
  });

  it.each([["not json{"], ["[1,2]"], ['"text"'], ["null"]])("ignores corrupt or non-object prefs: %s", async (raw) => {
    localStorage.setItem(KEY, raw);
    const ui = await load();
    expect(ui.getState().sidebarWidth).toBe(224);
    expect(ui.getState().foldersNotice).toBe(false);
  });

  it("keeps partial prefs it does not know about", async () => {
    put({ sidebarCollapsed: true });
    const ui = await load();
    expect(ui.getState().sidebarCollapsed).toBe(true);
    expect(ui.getState().foldersNotice).toBe(true);
  });

  it("does not record the migration or show the notice when the write fails", async () => {
    put({ sidebarWidth: 208, projectFolders: false });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const ui = await load();
    expect(ui.getState().foldersNotice).toBe(false);
    expect(ui.getState().sidebarWidth).toBe(208);
    vi.restoreAllMocks();
    expect(localStorage.getItem(MARKER)).toBeNull();
    // Storage works again: the migration runs on the next load.
    expect((await load()).getState().sidebarWidth).toBe(224);
  });

  it("survives an old build rewriting the prefs without any marker of its own", async () => {
    put({ projectFolders: false });
    const first = await load();
    first.getState().closeFoldersNotice(true);
    // A stale tab saves its own copy of the prefs, which knows nothing of the migration.
    put({ sidebarWidth: 208, projectFolders: false });
    const reloaded = await load();
    expect(reloaded.getState().projectFolders).toBe(false);
    expect(reloaded.getState().sidebarWidth).toBe(208);
    expect(reloaded.getState().foldersNotice).toBe(false);
  });

  it("Turn off sticks after a reload", async () => {
    put({ projectFolders: false });
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
