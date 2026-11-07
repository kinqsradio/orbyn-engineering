import { ChevronDown, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { commandShortcut, formatShortcut, useCommand } from "../../app/shortcuts";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Menu, type MenuItem } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";
import { launchableEditors, primaryEditor } from "./editorPreferences";

/** Opens the thread's checkout in an editor; a revealed path is not a choice of editor, so it does not become the favorite. */
function useEditorLauncher(threadId: string, fileManagerId: string | undefined) {
  const setPrefs = useUi((state) => state.setPrefs);
  const pushToast = useUi((state) => state.pushToast);
  return async (id: string) => {
    try {
      await api.openInEditor(threadId, { path: ".", editor: id });
      if (id !== fileManagerId) setPrefs({ preferredEditor: id });
    } catch (failure) {
      pushToast(`Couldn't open it. ${toFailure(failure).message}`);
    }
  };
}

/**
 * The favorite-editor key. It lives with the thread, not the Details card, so it still works while that card is a
 * popover that is closed or a panel that is hidden.
 */
export function FavoriteEditorShortcut({ threadId }: { threadId: string }) {
  const editors = useAsync("editors", (signal) => api.editors(signal));
  const preferred = useUi((state) => state.preferredEditor);
  const list = editors.data ?? [];
  const primary = primaryEditor(list, preferred);
  const open = useEditorLauncher(threadId, list.find((editor) => editor.file_manager)?.id);
  useCommand("editor.openFavorite", () => {
    if (!primary) return false;
    void open(primary.id);
  });
  return null;
}

/** Opens the thread's checkout, or a file at a line, in a detected editor. */
export function OpenInEditor({ threadId }: { threadId: string }) {
  const editors = useAsync("editors", (signal) => api.editors(signal));
  const keymap = useAsync("keybindings", (signal) => api.keybindings(signal));
  const preferred = useUi((state) => state.preferredEditor);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const list = editors.data ?? [];
  const launchable = launchableEditors(list);
  const primary = primaryEditor(list, preferred);
  const fileManager = list.find((editor) => editor.file_manager);
  const key = commandShortcut(keymap.data?.rules, "editor.openFavorite");
  const shortcut = key ? formatShortcut(key) : null;
  const open = useEditorLauncher(threadId, fileManager?.id);

  if (!primary) return null;
  const items: MenuItem[] = [
    ...launchable.map((editor) => ({
      label: editor.name,
      selected: editor.id === primary.id,
      ...(editor.id === primary.id && shortcut ? { shortcut } : {}),
      onSelect: () => void open(editor.id),
    })),
    ...(fileManager
      ? [{ label: `Reveal in ${fileManager.name}`, separatorBefore: true, onSelect: () => void open(fileManager.id) }]
      : []),
  ];
  return (
    <div className="detail-row detail-row-static" role="group" aria-label="Open in editor">
      <SquareArrowOutUpRight size={16} aria-hidden />
      <button type="button" className="detail-open" onClick={() => void open(primary.id)}>
        Open in {primary.name}
      </button>
      {items.length > 1 ? (
        <IconButton
          label="Choose editor"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <ChevronDown size={14} aria-hidden />
        </IconButton>
      ) : null}
      <Presence>{menu ? (
        <Menu
          {...menu}
          label="Open in"
          onClose={() => setMenu(null)}
          items={items}
        />
      ) : null}</Presence>
    </div>
  );
}
