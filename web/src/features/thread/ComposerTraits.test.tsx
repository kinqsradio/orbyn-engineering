import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import type { EngineStatus, PermissionMode } from "../../api/types";
import { offeredModes, shownAccess, useTraitsMenu } from "./ComposerTraits";

const withModes = (permission_modes?: PermissionMode[]) =>
  ({ capabilities: { permission_modes } }) as unknown as EngineStatus;

it("offers only the engine's modes and shows a missing saved mode as Supervised", () => {
  const pi = withModes(["full_access", "supervised", "auto_edits"]);
  expect(offeredModes(pi)).toEqual(["supervised", "auto_edits", "full_access"]);
  expect(shownAccess(pi, "auto")).toBe("supervised");
  expect(shownAccess(pi, "full_access")).toBe("full_access");
  expect(shownAccess(withModes(["supervised", "full_access"]), "auto_edits")).toBe("supervised");
  // An older service that does not list modes offers them all.
  expect(offeredModes(withModes(undefined))).toHaveLength(4);
  expect(offeredModes(null)).toHaveLength(4);
});

function Menu({ modes }: { modes: PermissionMode[] }) {
  const traits = useTraitsMenu({
    model: null,
    effort: null,
    extras: {},
    access: "supervised",
    modes,
    onEffort: () => {},
    onOption: () => {},
    onAccess: () => {},
  });
  return (
    <>
      <button type="button" onClick={(event) => traits.openAt(event.currentTarget, true)}>
        open
      </button>
      {traits.menu}
    </>
  );
}

it("lists only the offered modes in the permissions menu", () => {
  render(<Menu modes={["supervised", "auto"]} />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  const group = screen.getByRole("group", { name: "Permissions" });
  const labels = [...group.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  expect(labels).toEqual(["Supervised", "Auto"]);
});
