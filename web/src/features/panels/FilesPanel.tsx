import { AppWindow, ChevronRight, Copy, Download, ExternalLink, File, Folder, Paperclip, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api, request } from "../../api/client";
import type { FileContent, FileEntry, SearchHit } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useComposerChips } from "../thread/composerChipStore";
import { chipId, fileExcerpt, languageForPath } from "../thread/composerContext";
import { Button, IconButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";
import { FILE_MENTION_TYPE } from "../../lib/skillMention";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { DocumentViewer, officeKind } from "./DocumentViewer";
import { FileBytes, FileMedia, mediaKind, rawUrl } from "./FileMedia";
import { FilePreview, previewKind } from "./FilePreview";
import { ZipViewer, isZipPath } from "./ZipViewer";
import { formatBytes } from "./zipArchive";
import { useResolvedThreadPath } from "../thread/useResolvedThreadPath";
import { primaryEditor } from "../thread/editorPreferences";
import { useWorkspace } from "../../state/workspace";
import { FileComments } from "./FileComments";
import { OutsideFileViewer, fullPathOf, isFullPath } from "./OutsideFileViewer";

const q = encodeURIComponent;

/** Reads a file by what it holds, with the source a click away and edits saved safely. */
function FileBody({
  threadId,
  path,
  file,
  line,
  cwd,
  onSaved,
}: {
  threadId: string;
  path: string;
  file: FileContent;
  line: number | null;
  cwd: string;
  onSaved(): void;
}) {
  const kind = previewKind(path);
  const [mode, setMode] = useState<"preview" | "source" | "edit">(kind && !line ? "preview" : "source");
  const [text, setText] = useState(file.content);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await request("PUT", `/api/threads/${q(threadId)}/files/content`, {
        path,
        content: text,
        base_revision: file.revision,
      });
      setMode(kind ? "preview" : "source");
      onSaved();
    } catch (failure) {
      const known = toFailure(failure);
      setError(known.status === 409 ? "This file changed on disk. Reload it before saving." : `Couldn't save. ${known.message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="file-modes segment" role="radiogroup" aria-label="View">
        {kind ? (
          <button type="button" role="radio" aria-checked={mode === "preview"} onClick={() => setMode("preview")}>
            Preview
          </button>
        ) : null}
        <button type="button" role="radio" aria-checked={mode === "source"} onClick={() => setMode("source")}>
          Source
        </button>
        <button type="button" role="radio" aria-checked={mode === "edit"} onClick={() => setMode("edit")}>
          Edit
        </button>
      </div>
      {mode === "preview" && kind ? <FilePreview kind={kind} text={file.content} /> : null}
      {mode === "source" ? <FileComments key={`${threadId}:${cwd}:${path}:${file.revision}`} threadId={threadId} cwd={cwd}
        path={path} revision={file.revision} text={file.content} revealedLine={line} /> : null}
      {mode === "edit" ? (
        <div className="file-editor">
          <textarea aria-label={`Edit ${path}`} value={text} spellCheck={false} onChange={(event) => setText(event.target.value)} />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button small disabled={saving || text === file.content} onClick={() => void save()}>
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Exported so the panel bar's own controls can be tested from one file. */
export function Viewer({ threadId, path, line, onBack }: { threadId: string; path: string; line: number | null; onBack(): void }) {
  const cwd = useWorkspace((state) => state.threads[threadId]?.cwd ?? "");
  const media = mediaKind(path);
  // An archive is read as a folder list rather than as bytes, so it never
  // reaches the hex view even though the service calls the file binary.
  const zip = isZipPath(path);
  // A Word document is read the same way: its own bytes, through the worker.
  const office = officeKind(path);
  const read = useAsync(`file:${JSON.stringify([threadId, cwd, media ? "" : path])}`, async (signal) => {
    const content = media ? null : await request<FileContent>("GET", `/api/threads/${q(threadId)}/files/content?path=${q(path)}`, undefined, signal);
    if ((useWorkspace.getState().threads[threadId]?.cwd ?? "") !== cwd) throw new DOMException("Checkout changed", "AbortError");
    return { cwd, path, content };
  });
  // Key changes are cleared by an effect; never expose old bytes in that render.
  const file = { ...read, data: read.data?.cwd === cwd && read.data.path === path ? read.data.content : null };
  const preferred = useUi((state) => state.preferredEditor);
  const pushToast = useUi((state) => state.pushToast);
  const [copying, setCopying] = useState(false);
  // Only a complete, non-binary file has text to copy: a media file is never
  // read here, and a truncated one is not all there is.
  const copyable = file.data && !file.data.binary && !file.data.truncated ? file.data.content : null;
  const copyContents = async () => {
    if (copyable === null) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      pushToast("Couldn't copy. The clipboard is unavailable.");
      return;
    }
    setCopying(true);
    try {
      await clipboard.writeText(copyable);
      pushToast("Contents copied");
    } catch (failure) {
      const reason = failure instanceof Error && failure.message ? failure.message : "The clipboard is unavailable.";
      pushToast(`Couldn't copy. ${reason}`);
    } finally {
      setCopying(false);
    }
  };
  const open = async () => {
    try {
      const editors = await api.editors();
      const editor = primaryEditor(editors, preferred);
      if (!editor) return;
      await api.openInEditor(threadId, { path, editor: editor.id, ...(line ? { line } : {}) });
    } catch (failure) {
      pushToast(`Couldn't open it. ${toFailure(failure).message}`);
    }
  };
  const openInBrowser = async () => {
    try {
      await request("POST", `/api/threads/${encodeURIComponent(threadId)}/previews/file`, { path });
      useUi.getState().showInBrowser("");
    } catch (failure) {
      pushToast(`Couldn't open it. ${toFailure(failure).message}`);
    }
  };
  return (
    <div className="files-viewer" data-thread-id={threadId}>
      <div className="panel-bar">
        <Button small tone="quiet" onClick={onBack}>
          Files
        </Button>
        <code title={path}>{path}</code>
        {file.data && (zip || office) ? <span className="zip-size">{formatBytes(file.data.size)}</span> : null}
        <IconButton label="Copy contents" disabled={copyable === null || copying} onClick={() => void copyContents()}>
          <Copy size={14} aria-hidden />
        </IconButton>
        <IconButton
          label="Add file to message"
          disabled={copyable === null}
          onClick={() => {
            useComposerChips.getState().add(threadId, {
              id: chipId(),
              kind: "file",
              path,
              line,
              excerpt: copyable === null ? null : fileExcerpt(copyable, line),
              language: languageForPath(path),
            });
            pushToast("File added to your message");
          }}
        >
          <Paperclip size={14} aria-hidden />
        </IconButton>
        <a className="icon-btn" aria-label="Save file" title="Save file" href={rawUrl(threadId, path, true)} download>
          <Download size={14} aria-hidden />
        </a>
        {/\.x?html?$/i.test(path) ? (
          <IconButton label="Open in browser" onClick={() => void openInBrowser()}>
            <AppWindow size={14} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton label="Open in editor" onClick={() => void open()}>
          <ExternalLink size={14} aria-hidden />
        </IconButton>
      </div>
      {media ? (
        <FileMedia kind={media} threadId={threadId} path={path} />
      ) : file.status === "loading" ? (
        <Loading label="Loading file" rows={6} />
      ) : file.status === "error" && file.error.status === 404 ? (
        // A moved thread reads its files from the new checkout, which may not have this one.
        <Empty title="This file isn't in this checkout." />
      ) : file.status === "error" ? (
        <ErrorState compact title="Couldn't read this file" failure={file.error} onRetry={file.reload} />
      ) : !file.data ? null : zip ? (
        <ZipViewer threadId={threadId} path={path} size={file.data.size} />
      ) : office ? (
        <DocumentViewer threadId={threadId} path={path} kind={office} size={file.data.size} />
      ) : file.data.binary ? (
        <FileBytes threadId={threadId} path={path} size={file.data.size} as="hex" />
      ) : file.data.truncated ? (
        <FileBytes threadId={threadId} path={path} size={file.data.size} as="text" />
      ) : (
        <FileBody threadId={threadId} cwd={cwd} path={path} file={file.data} line={line} onSaved={file.reload} />
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
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const editors = useAsync("editors", (signal) => api.editors(signal));
  const pushToast = useUi((state) => state.pushToast);
  const openWith = (path: string, editor: string) => {
    api.openInEditor(threadId, { path, editor }).catch((failure: unknown) => {
      pushToast(`Couldn't open it. ${toFailure(failure).message}`);
    });
  };
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
            draggable
            onDragStart={(event) => event.dataTransfer.setData(FILE_MENTION_TYPE, entry.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, entry });
            }}
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
      <Presence>{menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.entry.name}`}
          onClose={() => setMenu(null)}
          items={[
            ...(menu.entry.is_dir ? [] : [{ label: "Open", onSelect: () => onFile(menu.entry.path) }]),
            ...(editors.data ?? []).map((editor) => ({
              label: editor.file_manager ? `Reveal in ${editor.name}` : `Open in ${editor.name}`,
              onSelect: () => openWith(menu.entry.path, editor.id),
            })),
          ]}
        />
      ) : null}</Presence>
    </ul>
  );
}

/** The checkout's files. A search finds names and, with text, lines. */
export function FilesPanel({ threadId }: { threadId: string }) {
  const [file, setFile] = useState<{ path: string; line: number | null } | null>(null);
  // A full path outside the checkout, opened read-only.
  const [outside, setOutside] = useState<string | null>(null);
  // A link in a message opens its file here, once per click.
  const reveal = useUi((state) => state.fileReveal);
  const resolved = useResolvedThreadPath(threadId, reveal ? { ...reveal, basis: "thread" } : null);
  const pushToast = useUi((state) => state.pushToast);
  const consume = useUi((state) => state.consumeFileReveal);
  const referenceKey = reveal ? JSON.stringify([reveal.path, reveal.line, reveal.nonce]) : null;
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal) return;
    if (reveal.threadId !== threadId || useWorkspace.getState().threads[threadId]?.cwd !== reveal.cwd) consume(reveal.nonce);
  }, [reveal, threadId, resolved.key, consume]);
  useEffect(() => {
    if (!reveal || referenceKey === seen || (!resolved.value && !resolved.error)) return;
    if (useUi.getState().fileReveal?.nonce !== reveal.nonce || reveal.threadId !== threadId
      || useWorkspace.getState().threads[threadId]?.cwd !== reveal.cwd) return;
    setSeen(referenceKey);
    const full = fullPathOf(reveal.path);
    if (resolved.value?.checkout_path) {
      setOutside(null);
      setFile({ path: resolved.value.checkout_path, line: reveal.line });
    } else if (resolved.value && isFullPath(full)) setOutside(full);
    else pushToast(resolved.error?.message ?? "That path is outside this checkout.");
    consume(reveal.nonce);
  }, [reveal, referenceKey, resolved.value, resolved.error, seen, pushToast, consume, threadId]);
  const chooseFile = (file: { path: string; line: number | null } | null) => {
    setSeen(referenceKey);
    const current = useUi.getState().fileReveal;
    if (current) consume(current.nonce);
    setOutside(null);
    setFile(file);
  };
  const chooseOutside = (path: string) => {
    chooseFile(null);
    setOutside(path);
  };
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const hits = useAsync(`file-search:${threadId}:${query}`, (signal) =>
    query
      ? request<SearchHit[]>("GET", `/api/threads/${q(threadId)}/files/search?q=${q(query)}&content=true`, undefined, signal)
      : Promise.resolve([]),
  );
  if (outside) return <OutsideFileViewer key={outside} threadId={threadId} path={outside} onBack={() => chooseFile(null)} />;
  if (file) return <Viewer threadId={threadId} path={file.path} line={file.line} onBack={() => chooseFile(null)} />;
  return (
    <div className="files-panel">
      <label className="pulls-search files-search">
        <Search size={14} aria-hidden />
        <input
          aria-label="Search files"
          placeholder="Search files, or a full path to read"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (!event.target.value) setQuery("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const typed = fullPathOf(text.trim());
            // A full path opens that one file to read; anything else searches the checkout.
            if (isFullPath(typed)) chooseOutside(typed);
            else setQuery(text.trim());
          }}
        />
      </label>
      {query ? (
        <ul className="file-tree">
          {(hits.data ?? []).map((hit) => (
            <li key={`${hit.path}:${hit.line}`}>
              <button type="button" onClick={() => chooseFile({ path: hit.path, line: hit.line || null })}>
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
        <FolderList threadId={threadId} path="" depth={0} onFile={(path) => chooseFile({ path, line: null })} />
      )}
    </div>
  );
}
