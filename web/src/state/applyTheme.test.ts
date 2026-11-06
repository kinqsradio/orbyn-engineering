import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, useUi } from "./ui";

const root = document.documentElement;

beforeEach(() => {
  root.removeAttribute("style");
  useUi.setState({ darkPreset: null, lightPreset: null, customColors: {} });
});

describe("applyTheme presets", () => {
  it("leaves Dim to tokens.css: a data-preset and no inline colours", () => {
    useUi.setState({ darkPreset: "dim" });
    applyTheme("dark");
    expect(root.dataset.preset).toBe("dim");
    expect(root.style.getPropertyValue("--color-background")).toBe("");
  });

  it("lets a custom colour override Dim", () => {
    useUi.setState({ darkPreset: "dim", customColors: { "--color-background": "#202020" } });
    applyTheme("dark");
    expect(root.style.getPropertyValue("--color-background")).toBe("#202020");
  });

  it("still applies the other presets inline and clears the marker without one", () => {
    useUi.setState({ darkPreset: "dusk" });
    applyTheme("dark");
    expect(root.dataset.preset).toBe("dusk");
    expect(root.style.getPropertyValue("--color-background")).toBe("#14161c");
    useUi.setState({ darkPreset: null });
    applyTheme("dark");
    expect(root.dataset.preset).toBeUndefined();
  });
});
