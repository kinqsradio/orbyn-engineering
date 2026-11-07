import { expect, it } from "vitest";
import type { RightTab } from "../../state/ui";
import { fitTabs } from "./tabs";

const ids: RightTab[] = ["diff", "files", "browser", "activity", "pulls", "side"];
const widths = new Map(ids.map((id) => [id, 50]));

it("keeps every tab when the row has room", () => {
  expect(fitTabs(ids, widths, 300, 24, null)).toEqual(ids);
});

it("folds the tabs that don't fit and keeps the open one, in order", () => {
  expect(fitTabs(ids, widths, 174, 24, "side")).toEqual(["diff", "files", "side"]);
  expect(fitTabs(ids, widths, 174, 24, "diff")).toEqual(["diff", "files", "browser"]);
});
