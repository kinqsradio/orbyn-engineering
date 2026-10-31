import { ChevronDown, SquareArrowOutUpRight } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useCommand } from "../../app/shortcuts";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";

/** Opens the thread's checkout, or a file at a line, in a detected editor. */
export function OpenInEditor({ threadId }: { threadId: string }) {
  const editors = useAsync("editors", (signal) => api.editors(signal));
  const preferred = useUi((state) => state.preferredEditor);
  const setPrefs = useUi((state) => state.setPrefs);
  const pushToast = useUi((state) => state.pushToast);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const list = editors.data ?? [];
  const primary = list.find((editor) => editor.id === preferred) ?? list.find((editor) => !editor.file_manager) ?? list[0];

  const open = async (id: string) => {
    try {
      await api.openInEditor(threadId, { path: ".", editor: id });
      setPrefs({ preferredEditor: id });
    } catch (failure) {
      pushToast(`Couldn't open it. ${toFailure(failure).message}`);
    }
  };

  useCommand("editor.openFavorite", () => {
    if (!primary) return false;
    void open(primary.id);
  });

  if (!primary) return null;
  return (
    <div className="detail-row detail-row-static" role="group" aria-label="Open in editor">
      <SquareArrowOutUpRight size={16} aria-hidden />
      <button type="button" className="detail-open" onClick={() => void open(primary.id)}>
        Open in {primary.name}
      </button>
      {list.length > 1 ? (
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
      {menu ? (
        <Menu
          {...menu}
          label="Open in"
          onClose={() => setMenu(null)}
          items={list.map((editor) => ({
            label: editor.name,
            selected: editor.id === primary.id,
            onSelect: () => void open(editor.id),
          }))}
        />
      ) : null}
    </div>
  );
}
