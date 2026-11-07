import { AlertTriangle, ArrowUp, ChevronRight, Folder } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { Button, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Loading } from "../../ui/states";

/**
 * The base-directory picker (dialog-base-directory, -empty, -error). It has actions, so it has a
 * footer and no Close; Cancel takes focus. A folder row opens that folder and "Use this folder"
 * picks the one shown. The path is editable: Enter or leaving the field jumps to what was typed.
 */
export function BaseDirectoryDialog({ onChoose, onClose }: { onChoose(path: string): void; onClose(): void }) {
  const [path, setPath] = useState<string | null>(null);
  const listing = useAsync(`browse:${path ?? ""}`, (signal) => api.browse(path, signal));
  const shown = listing.data?.path ?? path ?? "";
  const [typed, setTyped] = useState<string | null>(null);

  const jump = () => {
    const next = typed?.trim();
    setTyped(null);
    if (next && next !== shown) setPath(next);
  };

  return (
    <Dialog
      title="Base directory"
      className="folder-dialog"
      onClose={onClose}
      footer={
        <>
          <Button data-dialog-focus onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!listing.data} onClick={() => listing.data && onChoose(listing.data.path)}>
            Use this folder
          </Button>
        </>
      }
    >
      <p>New projects are created in this folder. Open a folder to look inside it, then use the folder that is shown.</p>
      <div className="folder-bar">
        <IconButton label="Up one level" disabled={!listing.data?.parent} onClick={() => setPath(listing.data?.parent ?? null)}>
          <ArrowUp size={16} aria-hidden />
        </IconButton>
        <input
          className="dialog-field dialog-field-mono folder-path"
          aria-label="Folder path"
          spellCheck={false}
          value={typed ?? shown}
          onChange={(event) => setTyped(event.target.value)}
          onBlur={jump}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              jump();
            }
          }}
        />
      </div>
      {listing.status === "loading" ? (
        <Loading label="Loading folders" rows={4} />
      ) : listing.status === "error" ? (
        <div className="folder-list">
          <div className="folder-row" role="alert">
            <AlertTriangle size={16} aria-hidden />
            <span>Couldn’t read this folder.</span>
            <Button small onClick={listing.reload}>
              Try again
            </Button>
          </div>
        </div>
      ) : listing.data.entries.length === 0 ? (
        <div className="folder-list">
          <div className="folder-row">
            <span />
            <span className="folder-none">No folders here.</span>
          </div>
        </div>
      ) : (
        <ul className="folder-list" aria-label="Folders">
          {listing.data.entries.map((entry) => (
            <li key={entry.path}>
              <button type="button" className="folder-row" onClick={() => setPath(entry.path)}>
                <Folder size={16} aria-hidden />
                <span>{entry.name}</span>
                <ChevronRight size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
