import { afterEach, describe, expect, it } from "vitest";
import { useUi } from "../state/ui";
import { onShellEvent } from "./Shell";

describe("onShellEvent", () => {
  afterEach(() => {
    window.location.hash = "";
    useUi.getState().showInBrowser(null);
  });

  it("shows the preview the service opened for a link from another app", () => {
    onShellEvent({ type: "show_preview", thread_id: "t1", tab_id: "tab-1" });
    expect(window.location.hash).toBe("#/threads/t1");
    const state = useUi.getState();
    expect(state.previewRequest).toEqual({ tabId: "tab-1" });
    expect(state.panelOpen).toBe(true);
    expect(state.panelTab).toBe("browser");
  });
});
