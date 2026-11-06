import type { EditorInfo } from "../api/types";

/** Editors that can open a file. The file manager only reveals a path. */
export const launchableEditors = (editors: EditorInfo[]): EditorInfo[] =>
  editors.filter((editor) => !editor.file_manager);

/**
 * The remembered editor when it is installed, else the first one that can open
 * files. Never the file manager, so a host with no editor hides the control.
 */
export function primaryEditor(editors: EditorInfo[], preferred: string | null): EditorInfo | null {
  const launchable = launchableEditors(editors);
  return launchable.find((editor) => editor.id === preferred) ?? launchable[0] ?? null;
}
