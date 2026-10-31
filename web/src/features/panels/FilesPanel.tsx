import { ChevronRight, ExternalLink, File, Folder, Search } from "lucide-react";
import { useState } from "react";
import { api, request } from "../../api/client";
import type { FileContent, FileEntry, SearchHit } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";

const q = encodeURIComponent;

const scrollToMarkedLine = (element: HTMLPreElement | null) => {
  element?.querySelector("[data-line]")?.scrollIntoView({ block: "center" });
};

function Viewer({ threadId, path, line, onBack }: { threadId: string; path: string; line: number | null; onBack(): void }) {
  const file = useAsync(`file:${threadId}:${path}`, (signal) =>
    request<FileContent>("GET", `/api/threads/${q(threadId)}/files/content?path=${q(path)}`, undefined, signal),
  );
  const preferred = useUi((state) => state.preferredEditor);
  const pushToast = useUi((state) => state.pushToast);
  const open = async () => {
    try {
      const editors = await api.editors();
      const editor = editors.find((entry) => entry.id === preferred) ?? editors[0];
      if (!editor) return;
      await api.openInEditor(threadId, { path, editor: editor.id, ...(line ? { line } : {}) });
    } catch (failure) {
      pushToast(`Couldn't open it. ${toFailure(failure).message}`);
    }
  };
  return (
    <div className="files-viewer">
      <div className="panel-bar">
        <Button small tone="quiet" onClick={onBack}>
          Files
        </Button>
        <code title={path}>{path}</code>
        <IconButton label="Open in editor" onClick={() => void open()}>
          <ExternalLink size={14} aria-hidden />
        </IconButton>
      </div>
      {file.status === "loading" ? (
        <Loading label="Loading file" rows={6} />
      ) : file.status === "error" ? (
        <ErrorState compact title="Couldn't read this file" failure={file.error} onRetry={file.reload} />
      ) : file.data.binary ? (
        <p className="muted">This is a binary file.</p>
      ) : (
        <pre tabIndex={0} className="file-source" ref={scrollToMarkedLine}>
          {file.data.content.split("\n").map((text, at) => (
            <span key={at} data-line={at + 1 === line || undefined}>
              <i>{at + 1}</i>
              {text}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

function FolderList({
  threadId,
  path,
  depth,
  onFile,
}: {
  threadId: string;
  path: string;
  depth: number;
  onFile(path: string): void;
}) {
  const list = useAsync(`files:${threadId}:${path}`, (signal) =>
    request<FileEntry[]>("GET", `/api/threads/${q(threadId)}/files?path=${q(path)}`, undefined, signal),
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  if (list.status === "loading") return depth === 0 ? <Loading label="Loading files" rows={6} /> : null;
  if (list.status === "error") {
    return <ErrorState compact title="Couldn't read this folder" failure={list.error} onRetry={list.reload} />;
  }
  return (
    <ul className="file-tree">
      {list.data.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            style={{ paddingLeft: 8 + depth * 12 }}
            data-ignored={entry.ignored || undefined}
            aria-expanded={entry.is_dir ? open.has(entry.path) : undefined}
            onClick={() => {
              if (!entry.is_dir) {
                onFile(entry.path);
                return;
              }
              const next = new Set(open);
              if (!next.delete(entry.path)) next.add(entry.path);
              setOpen(next);
            }}
          >
            {entry.is_dir ? <ChevronRight size={12} className="chev" aria-hidden /> : <span className="file-gap" />}
            {entry.is_dir ? <Folder size={14} aria-hidden /> : <File size={14} aria-hidden />}
            <span>{entry.name}</span>
          </button>
          {entry.is_dir && open.has(entry.path) ? (
            <FolderList threadId={threadId} path={entry.path} depth={depth + 1} onFile={onFile} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The checkout's files. A search finds names and, with text, lines. */
export function FilesPanel({ threadId }: { threadId: string }) {
  const [file, setFile] = useState<{ path: string; line: number | null } | null>(null);
  // A link in a message opens its file here, once per click.
  const reveal = useUi((state) => state.fileReveal);
  const [seen, setSeen] = useState<number | null>(null);
  if (reveal && reveal.nonce !== seen) {
    setSeen(reveal.nonce);
    setFile({ path: reveal.path, line: reveal.line });
  }
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const hits = useAsync(`file-search:${threadId}:${query}`, (signal) =>
    query
      ? request<SearchHit[]>("GET", `/api/threads/${q(threadId)}/files/search?q=${q(query)}&content=true`, undefined, signal)
      : Promise.resolve([]),
  );
  if (file) return <Viewer threadId={threadId} path={file.path} line={file.line} onBack={() => setFile(null)} />;
  return (
    <div className="files-panel">
      <label className="pulls-search files-search">
        <Search size={14} aria-hidden />
        <input
          aria-label="Search files"
          placeholder="Search files"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (!event.target.value) setQuery("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") setQuery(text.trim());
          }}
        />
      </label>
      {query ? (
        <ul className="file-tree">
          {(hits.data ?? []).map((hit) => (
            <li key={`${hit.path}:${hit.line}`}>
              <button type="button" onClick={() => setFile({ path: hit.path, line: hit.line || null })}>
                <File size={14} aria-hidden />
                <span>
                  {hit.path}
                  {hit.line ? `:${hit.line}` : ""}
                </span>
              </button>
            </li>
          ))}
          {hits.status === "ready" && hits.data.length === 0 ? <li className="muted">No matches</li> : null}
        </ul>
      ) : (
        <FolderList threadId={threadId} path="" depth={0} onFile={(path) => setFile({ path, line: null })} />
      )}
    </div>
  );
}
