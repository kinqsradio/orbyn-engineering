import { expect, it } from "vitest";
import type { EditorInfo } from "../../api/types";
import { launchableEditors, primaryEditor } from "./editorPreferences";

const editor = (id: string, name: string, file_manager = false): EditorInfo => ({
  id,
  name,
  launch_style: file_manager ? "" : "goto",
  file_manager,
});

const finder = editor("file_manager", "Finder", true);
const code = editor("vscode", "VS Code");
const zed = editor("zed", "Zed");

it("keeps only editors that can open a file", () => {
  expect(launchableEditors([code, finder, zed])).toEqual([code, zed]);
});

it("uses the remembered editor when it is installed", () => {
  expect(primaryEditor([code, zed, finder], "zed")).toEqual(zed);
});

it("falls back to the first real editor, never the file manager", () => {
  expect(primaryEditor([finder, code, zed], "missing")).toEqual(code);
  expect(primaryEditor([finder, code], null)).toEqual(code);
});

it("hides the control when only the file manager is available", () => {
  expect(primaryEditor([finder], "file_manager")).toBeNull();
  expect(primaryEditor([], null)).toBeNull();
});
