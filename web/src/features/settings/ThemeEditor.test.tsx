import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { request } from "../../api/client";
import { useUi } from "../../state/ui";
import { readThemeFile } from "../../styles/themes";
import { AppearanceSection } from "./Appearance";
import { scopedFixture } from "./scopedPreferenceFixture.test-support";
vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));

async function openEditor() {
  vi.mocked(request).mockResolvedValue(scopedFixture([]));
  const user = userEvent.setup();
  render(<AppearanceSection />);
  await user.click(await screen.findByRole("button", { name: "Edit…" }));
  return user;
}

it("keeps the previous colour and names the reason when a token value isn't a colour", async () => {
  useUi.setState({ customColors: { "--color-primary": "#3b82f6" } });
  const user = await openEditor();
  const field = screen.getByRole("textbox", { name: "Accent" });
  await user.clear(field); await user.type(field, "#9a57"); await user.tab();
  expect(screen.getByText("Accent: “#9a57” is not a colour. Use #rgb, #rrggbb or rgba().")).toBeVisible();
  expect(useUi.getState().customColors["--color-primary"]).toBe("#3b82f6");
  await user.clear(field); await user.type(field, "rgba(0,0,0,.5)"); await user.tab();
  expect(useUi.getState().customColors["--color-primary"]).toBe("rgba(0,0,0,.5)");
});

it("says why an import can't be read and changes nothing", async () => {
  useUi.setState({ customColors: {} });
  const user = await openEditor();
  const bad = new File(['{\n  "colors": {\n    "--color-primary": "nope"\n  }\n}'], "light.json", { type: "application/json" });
  await user.upload(screen.getByLabelText("Import theme file"), bad);
  expect(await screen.findByText("Couldn't import light.json. Line 3: “Accent” is not a colour. Nothing changed.")).toBeVisible();
  expect(useUi.getState().customColors).toEqual({});
});

it("reads a VS Code theme's colours and refuses text that isn't JSON", () => {
  expect(readThemeFile('{"colors":{"editor.background":"#101010"}}')).toEqual({ colors: { "--color-background": "#101010" } });
  expect(readThemeFile("nope")).toEqual({ error: "It isn't valid JSON." });
});
