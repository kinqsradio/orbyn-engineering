import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "../state/ui";
import { adoptEnvironmentTheme } from "./environmentTheme";

describe("adoptEnvironmentTheme", () => {
  beforeEach(() => {
    useUi.getState().setPrefs({ theme: "dark", lightPreset: null, darkPreset: null, environmentThemeAppliedAt: 0 });
  });

  it("applies a newer published theme once and then leaves the viewer's choice", () => {
    expect(adoptEnvironmentTheme({ name: "paper", set_at: 10 })).toBe(true);
    expect(useUi.getState().theme).toBe("light");
    expect(useUi.getState().lightPreset).toBe("paper");
    expect(document.documentElement.dataset.theme).toBe("light");
    useUi.getState().setTheme("dark");
    expect(adoptEnvironmentTheme({ name: "paper", set_at: 10 })).toBe(false);
    expect(useUi.getState().theme).toBe("dark");
    expect(adoptEnvironmentTheme({ name: "system", set_at: 11 })).toBe(true);
    expect(useUi.getState().theme).toBe("system");
  });

  it("skips nothing published and records an unknown name without changing the theme", () => {
    expect(adoptEnvironmentTheme(undefined)).toBe(false);
    expect(adoptEnvironmentTheme({ name: "someone-elses", set_at: 5 })).toBe(false);
    expect(useUi.getState().theme).toBe("dark");
    expect(useUi.getState().environmentThemeAppliedAt).toBe(5);
  });
});
