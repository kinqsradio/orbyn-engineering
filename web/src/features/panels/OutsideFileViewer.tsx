import { Copy, Lock } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { FilePreview, previewKind } from "./FilePreview";
import { formatBytes } from "./zipArchive";

/** A full path: `/…`, `C:\…`, `C:/…` or `\\…`. Only routing; the service decides. */
export function isFullPath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

/** `file:///C:/x` arrives as `/C:/x`; that names `C:/x`. */
export function fullPathOf(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

// Nothing a page from outside the checkout names may load: no script, no network,
// no frames. The frame's empty `sandbox` already gives it an opaque origin with no
// scripts, forms or top navigation; this policy is the second wall.
const ISOLATION = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">`;

/** HTML from outside the checkout, isolated from this app, its token and its API. */
export function IsolatedHtml({ text }: { text: string }) {
  return (
    <iframe
      className="file-frame"
      title="HTML preview, isolated"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={`<!doctype html>${ISOLATION}${text}`}
    />
  );
}

/** Shows a file outside the checkout that the person opened. It can't be edited or saved. */
export function OutsideFileViewer({ threadId, path, onBack }: { threadId: string; path: string; onBack(): void }) {
  const read = useAsync(`outside-file:${JSON.stringify([threadId, path])}`, (signal) => api.readOutsideFile(threadId, path, signal));
  const file = read.status === "ready" ? read.data : null;
  const kind = previewKind(path);
  const [mode, setMode] = useState<"preview" | "source">(kind ? "preview" : "source");
  const pushToast = useUi((state) => state.pushToast);
  const copyable = file && !file.binary && !file.truncated ? file.content : null;
  const copy = async () => {
    if (copyable === null) return;
    try {
      await navigator.clipboard.writeText(copyable);
      pushToast("Contents copied");
    } catch {
      pushToast("Couldn't copy. The clipboard is unavailable.");
    }
  };
  return (
    <div className="files-viewer outside-file" data-thread-id={threadId} data-read-only="true">
      <div className="panel-bar">
        <Button small tone="quiet" onClick={onBack}>
          Files
        </Button>
        <code title={file?.path ?? path}>{file?.path ?? path}</code>
        <span className="outside-badge" title="This file is outside the thread's checkout. Orbyn only shows it.">
          <Lock size={12} aria-hidden />
          Outside checkout · Read-only
        </span>
        <IconButton label="Copy contents" disabled={copyable === null} onClick={() => void copy()}>
          <Copy size={14} aria-hidden />
        </IconButton>
      </div>
      {read.status === "loading" ? (
        <Loading label="Loading file" rows={6} />
      ) : read.status === "error" && read.error.status === 404 ? (
        <Empty title="That file wasn't found." />
      ) : read.status === "error" ? (
        <ErrorState compact title="Couldn't show this file" failure={read.error} onRetry={read.reload} />
      ) : !file ? null : file.truncated ? (
        <Empty title={`This file is too large to show here (${formatBytes(file.size)}).`} />
      ) : file.binary ? (
        <Empty title={`This file isn't text (${formatBytes(file.size)}).`} />
      ) : (
        <>
          {kind ? (
            <div className="file-modes segment" role="radiogroup" aria-label="View">
              <button type="button" role="radio" aria-checked={mode === "preview"} onClick={() => setMode("preview")}>
                Preview
              </button>
              <button type="button" role="radio" aria-checked={mode === "source"} onClick={() => setMode("source")}>
                Source
              </button>
            </div>
          ) : null}
          {mode === "preview" && kind === "html" ? (
            <IsolatedHtml text={file.content} />
          ) : mode === "preview" && kind ? (
            <FilePreview kind={kind} text={file.content} />
          ) : (
            <pre className="file-source" tabIndex={0} aria-label={`Source of ${file.path}`}>
              {file.content}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
