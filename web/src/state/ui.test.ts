import { beforeEach, describe, expect, it } from "vitest";
import { DRAFT_LAYOUT, useUi } from "./ui";

const ui = () => useUi.getState();

beforeEach(() => {
  ui().setLayoutKey(DRAFT_LAYOUT);
  useUi.setState({ layouts: {}, panelOpen: null, panelTab: null, openSurfaces: [], terminalOpen: false, panelWidth: null });
});

describe("thread layouts", () => {
  it("restores each thread's pane, tab, width, terminal and maximize", () => {
    ui().setLayoutKey("a");
    ui().togglePanel("diff");
    ui().setPanelWidth(420);
    ui().togglePanel("terminal");
    ui().setPanelMaximized(true);

    ui().setLayoutKey("b");
    expect(ui().panelOpen).toBeNull();
    expect(ui().terminalOpen).toBe(false);
    expect(ui().panelMaximized).toBe(false);
    ui().togglePanel("activity");

    ui().setLayoutKey("a");
    expect(ui()).toMatchObject({
      panelOpen: true,
      panelTab: "diff",
      panelWidth: 420,
      terminalOpen: true,
      panelMaximized: true,
    });
    ui().setLayoutKey("b");
    expect(ui().panelTab).toBe("activity");
  });

  it("hands a sent draft's layout to its thread and starts the next draft fresh", () => {
    ui().setPanelOpen(true);
    ui().adoptDraftLayout("t1");
    expect(ui().layoutKey).toBe("t1");
    expect(ui().panelOpen).toBe(true);
    ui().setLayoutKey(DRAFT_LAYOUT);
    expect(ui().panelOpen).toBeNull();
    ui().setLayoutKey("t1");
    expect(ui().panelOpen).toBe(true);
  });
});
