import { FileCode, FileText } from "lucide-react";
import { use, useEffect, useRef, useState } from "react";
import { attachmentBlob } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Dialog } from "../../ui/Dialog";
import { TimelineThread } from "./items";
import { Lightbox } from "./MarkdownMedia";
import { fileLinkTarget } from "./MarkdownLink";
import type { SentAttachment } from "./projection";

/** A typed `@path` the message referred to. */
const PATH_TOKEN = /(^|\s)@([^\s@]+)/g;
const TRAILING = /[.,;:!?)\]]+$/;
/** Text longer than this is downloaded instead of shown. */
const PREVIEW_BYTES = 256 * 1024;

/** Every distinct path a user typed as an `@` mention. */
export function sentPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const path = match[2]?.replace(TRAILING, "") ?? "";
    if (!path || !/[/.]/.test(path) || found.includes(path)) continue;
    found.push(path);
  }
  return found;
}

const basename = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

const sizeLabel = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1_048_576
      ? `${Math.round(bytes / 1024)} KiB`
      : `${(bytes / 1_048_576).toFixed(1)} MiB`;

const textual = (mime: string) =>
  /^text\//.test(mime) ||
  /^application\/(json|xml|yaml|x-yaml|toml|sql|javascript|typescript|x-sh)$/.test(mime);

interface Shown {
  name: string;
  body: string;
  kind: "image" | "text";
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** What a sent user message carried: files by name and paths by mention. */
export function SentFiles({
  attachments,
  text,
}: {
  attachments?: readonly SentAttachment[];
  text: string;
}) {
  const threadId = use(TimelineThread);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const open = async (file: SentAttachment) => {
    setError(null);
    setBusy(file.id);
    try {
      const blob = await attachmentBlob(file.id);
      if (file.mime.startsWith("image/")) {
        const url = URL.createObjectURL(blob);
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = url;
        setShown({ name: file.name, body: url, kind: "image" });
      } else if (textual(file.mime) && blob.size <= PREVIEW_BYTES) {
        setShown({ name: file.name, body: await blob.text(), kind: "text" });
      } else {
        download(blob, file.name);
      }
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(null);
    }
  };

  const reveal = (path: string) => {
    const target = fileLinkTarget(path);
    if (!target) return;
    const thread = threadId ? useWorkspace.getState().threads[threadId] : null;
    if (thread) useUi.getState().revealFile(target.path, target.line, { threadId: thread.id, cwd: thread.cwd });
  };

  const files = attachments ?? [];
  const paths = sentPaths(text);
  if (files.length === 0 && paths.length === 0) return null;

  return (
    <>
      <ul className="sent-files" aria-label="Sent with this message">
        {files.map((file) => (
          <li key={`file:${file.id}`}>
            <button
              type="button"
              disabled={busy === file.id}
              aria-label={`Open ${file.name}`}
              title={`${file.name} · ${sizeLabel(file.size)}`}
              onClick={() => void open(file)}
            >
              <FileText size={12} aria-hidden />
              <span>{file.name}</span>
            </button>
          </li>
        ))}
        {paths.map((path) => (
          <li key={`path:${path}`}>
            <button
              type="button"
              className="sent-path"
              aria-label={`Show ${path}`}
              title={path}
              onClick={() => reveal(path)}
            >
              <FileCode size={12} aria-hidden />
              <span>{basename(path)}</span>
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="sent-files-error" role="alert">
          {error}
        </p>
      ) : null}
      {shown?.kind === "image" ? (
        <Lightbox src={shown.body} alt={shown.name} onClose={() => setShown(null)} />
      ) : null}
      {shown?.kind === "text" ? (
        <Dialog title={shown.name} onClose={() => setShown(null)}>
          <pre className="sent-preview-text">{shown.body}</pre>
        </Dialog>
      ) : null}
    </>
  );
}
