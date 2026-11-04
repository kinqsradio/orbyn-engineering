import { ChevronRight, Download, File, Folder } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { ApiFailure } from "../../api/client";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { BytesFallback, rawUrl } from "./FileMedia";
import { FilePreview, previewKind } from "./FilePreview";
import {
  ZipError,
  buildZipTree,
  decodeEntryText,
  formatBytes,
  looksBinary,
  readEntryBytes,
  readZipArchive,
  type ZipEntry,
  type ZipReadResult,
  type ZipTreeNode,
} from "./zipArchive";

/** Only the name decides, the way a path is typed elsewhere in the panel. */
export function isZipPath(path: string): boolean {
  return /\.zip$/i.test(path);
}

interface ZipLoad {
  bytes: Uint8Array<ArrayBuffer>;
  read: ZipReadResult;
}

/** The archive's own bytes, through the route that already carries the token. */
async function loadArchive(threadId: string, path: string, signal: AbortSignal): Promise<ZipLoad> {
  const response = await fetch(rawUrl(threadId, path), { credentials: "same-origin", signal });
  if (!response.ok) {
    throw new ApiFailure(`http_${response.status}`, `The service answered ${response.status}.`, response.status);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, read: readZipArchive(bytes) };
}

type EntryView =
  | { status: "idle" }
  | { status: "loading"; entry: ZipEntry }
  | { status: "ready"; entry: ZipEntry; binary: boolean; text: string; bytes: Uint8Array<ArrayBuffer> }
  | { status: "error"; entry: ZipEntry; message: string };

/** One row per entry, nested by the entry's own `/` path. */
function TreeRows({
  nodes,
  depth,
  open,
  selected,
  onToggle,
  onOpen,
}: {
  nodes: readonly ZipTreeNode[];
  depth: number;
  open: ReadonlySet<string>;
  selected: string | null;
  onToggle(path: string): void;
  onOpen(entry: ZipEntry): void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <Fragment key={node.key}>
          <li>
            <button
              type="button"
              style={{ paddingLeft: 8 + depth * 12 }}
              data-selected={selected === node.path || undefined}
              aria-expanded={node.isDirectory ? open.has(node.path) : undefined}
              onClick={() => (node.isDirectory || !node.entry ? onToggle(node.path) : onOpen(node.entry))}
            >
              {node.isDirectory ? (
                <ChevronRight size={12} className="chev" aria-hidden />
              ) : (
                <span className="file-gap" />
              )}
              {node.isDirectory ? <Folder size={14} aria-hidden /> : <File size={14} aria-hidden />}
              <span className="zip-name">{node.name}</span>
              {node.entry?.encrypted ? <span className="zip-badge">encrypted</span> : null}
              {node.isDirectory ? null : (
                <span className="zip-size">{formatBytes(node.entry?.uncompressedSize ?? 0)}</span>
              )}
            </button>
          </li>
          {node.isDirectory && open.has(node.path) ? (
            <TreeRows
              nodes={node.children}
              depth={depth + 1}
              open={open}
              selected={selected}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * A zip archive as a folder list, read from its own bytes. Entries are read on
 * demand, so a large archive costs one pass to list and one entry to open.
 */
export function ZipViewer({ threadId, path, size }: { threadId: string; path: string; size?: number }) {
  const archive = useAsync(`zip:${threadId}:${path}`, (signal) => loadArchive(threadId, path, signal));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<EntryView>({ status: "idle" });
  const [mode, setMode] = useState<"preview" | "source">("source");
  const pushToast = useUi((state) => state.pushToast);
  const read = archive.data?.read;
  const tree = useMemo(() => (read?.ok ? buildZipTree(read.entries) : []), [read]);
  const kind = view.status === "idle" ? null : previewKind(view.entry.path);

  const toggle = (path: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };

  const openEntry = async (entry: ZipEntry) => {
    if (!archive.data) return;
    setView({ status: "loading", entry });
    setMode(previewKind(entry.path) ? "preview" : "source");
    try {
      const bytes = await readEntryBytes(archive.data.bytes, entry);
      const binary = looksBinary(bytes);
      setView({ status: "ready", entry, binary, text: binary ? "" : decodeEntryText(bytes), bytes });
    } catch (failure) {
      setView({
        status: "error",
        entry,
        message: failure instanceof ZipError ? failure.message : toFailure(failure).message,
      });
    }
  };

  // Saving keeps the bytes in the page: a Blob hands one entry to the browser's
  // own download, so nothing is written into the archive or onto a path here.
  const saveEntry = async (entry: ZipEntry) => {
    if (!archive.data) return;
    try {
      const bytes =
        view.status === "ready" && view.entry === entry
          ? view.bytes
          : await readEntryBytes(archive.data.bytes, entry);
      const url = URL.createObjectURL(new Blob([bytes]));
      const link = document.createElement("a");
      link.href = url;
      link.download = entry.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (failure) {
      pushToast(failure instanceof ZipError ? failure.message : `Couldn't save this entry. ${toFailure(failure).message}`);
    }
  };

  if (archive.status === "loading") return <Loading label="Reading archive" rows={6} />;
  if (archive.status === "error") {
    return (
      <ErrorState compact title="Couldn't read this archive" failure={archive.error} onRetry={archive.reload} />
    );
  }
  if (!read) return null;
  if (!read.ok) {
    const refusal = (
      <ErrorState
        compact
        title="Couldn't read this archive"
        failure={new ApiFailure(read.code, read.message, 0)}
        onRetry={archive.reload}
      />
    );
    // An archive this reader won't list may still be something: its own bytes
    // are here, and the hex view reads any file.
    if (size === undefined) return refusal;
    return (
      <div className="office-refusal">
        {refusal}
        <BytesFallback threadId={threadId} path={path} size={size} />
      </div>
    );
  }

  return (
    <div className="zip-viewer">
      {tree.length === 0 ? (
        <p className="muted zip-empty">This archive holds no entries.</p>
      ) : (
        <ul className="file-tree zip-tree">
          <TreeRows
            nodes={tree}
            depth={0}
            open={open}
            selected={view.status === "idle" ? null : view.entry.path}
            onToggle={toggle}
            onOpen={(entry) => void openEntry(entry)}
          />
        </ul>
      )}
      {view.status === "idle" ? null : (
        <div className="zip-entry">
          <div className="panel-bar">
            <code title={view.entry.path}>{view.entry.path}</code>
            <span className="zip-size">{formatBytes(view.entry.uncompressedSize)}</span>
            {view.status === "ready" && view.binary ? (
              <IconButton label="Save entry" onClick={() => void saveEntry(view.entry)}>
                <Download size={14} aria-hidden />
              </IconButton>
            ) : null}
          </div>
          {view.status === "loading" ? <Loading label="Reading entry" rows={3} /> : null}
          {view.status === "error" ? (
            <p className="field-error" role="alert">
              {view.message}
            </p>
          ) : null}
          {view.status === "ready" && view.binary ? (
            <p className="muted zip-empty">This entry is not text, so it has no preview here. Save it to read it.</p>
          ) : null}
          {view.status === "ready" && !view.binary ? (
            <>
              {previewKind(view.entry.path) ? (
                <div className="file-modes segment" role="radiogroup" aria-label="Entry view">
                  <button type="button" role="radio" aria-checked={mode === "preview"} onClick={() => setMode("preview")}>
                    Preview
                  </button>
                  <button type="button" role="radio" aria-checked={mode === "source"} onClick={() => setMode("source")}>
                    Source
                  </button>
                </div>
              ) : null}
              {mode === "preview" && kind ? (
                <FilePreview kind={kind} text={view.text} />
              ) : (
                <pre tabIndex={0} className="file-source" aria-label={`Contents of ${view.entry.path}`}>
                  {view.text}
                </pre>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
