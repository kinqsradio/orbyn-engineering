import { ArrowUp, Folder, GitBranch } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";

export function FolderBrowser({
  actionLabel,
  busy,
  rowAction,
  onChoose,
}: {
  actionLabel: string;
  busy?: boolean;
  /** A label such as "Use": every folder row then carries a button that applies that folder at once. */
  rowAction?: string;
  onChoose(path: string): void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const listing = useAsync(`browse:${path ?? ""}`, (signal) => api.browse(path, signal));
  const current = listing.data?.path ?? path;

  return (
    <div className="browser">
      <div className="browser-bar">
        <Button
          small
          icon={<ArrowUp size={16} aria-hidden />}
          disabled={!listing.data?.parent}
          onClick={() => setPath(listing.data?.parent ?? null)}
        >
          Up
        </Button>
        <code className="browser-path" title={current ?? undefined}>
          {current ?? "Loading…"}
        </code>
      </div>
      {listing.status === "loading" ? (
        <Loading label="Loading folders" rows={4} />
      ) : listing.status === "error" ? (
        <ErrorState compact title="Couldn't read this folder" failure={listing.error} onRetry={listing.reload} />
      ) : listing.data.entries.length === 0 ? (
        <Empty title="No folders here" />
      ) : (
        <ul className="browser-list">
          {listing.data.entries.map((entry) => (
            <li key={entry.path} className={rowAction ? "browser-row" : undefined}>
              <button type="button" onClick={() => setPath(entry.path)}>
                {entry.is_git ? <GitBranch size={16} aria-hidden /> : <Folder size={16} aria-hidden />}
                <span>{entry.name}</span>
                {entry.is_git ? <span className="row-meta">Git repository</span> : null}
              </button>
              {rowAction ? (
                <Button small className="browser-use" aria-label={`${rowAction} ${entry.name}`} disabled={busy} onClick={() => onChoose(entry.path)}>
                  {rowAction}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="browser-foot">
        <Button
          tone="primary"
          busy={busy}
          disabled={!listing.data}
          onClick={() => {
            if (listing.data) onChoose(listing.data.path);
          }}
        >
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
