import { useRef } from "react";
import { authHeaders, request } from "../../api/client";
import { serviceUrl } from "../../api/origin";
import type { PreviewCopy } from "../../generated/PreviewCopy";
import type { PreviewDownload } from "../../generated/PreviewDownload";
import type { PreviewTab } from "../../generated/PreviewTab";
import type { PreviewUpload } from "../../generated/PreviewUpload";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";

const q = encodeURIComponent;

function tabBase(threadId: string, tabId: string): string {
  return `/api/threads/${q(threadId)}/previews/${q(tabId)}`;
}

async function bytesRequest(method: string, path: string, body?: Blob): Promise<Response> {
  const response = await fetch(serviceUrl(path), {
    method,
    credentials: "same-origin",
    headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
    body,
  });
  if (!response.ok) {
    let message = `The server answered ${response.status}.`;
    try {
      const failure = (await response.json()) as { message?: unknown };
      if (typeof failure.message === "string") message = failure.message;
    } catch {
      // Not an error body; the status says enough.
    }
    throw new Error(message);
  }
  return response;
}

/**
 * Puts what the person selected in the page they hold on their own clipboard. The
 * text is handed over as a promise inside the key press, which Safari's clipboard
 * needs, and plain text goes to browsers without clipboard items.
 */
export function copyFromPage(threadId: string, tabId: string): Promise<void> {
  const text = request<PreviewCopy>("POST", `${tabBase(threadId, tabId)}/copy`).then((copied) => copied.text);
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (!clipboard) return Promise.reject(new Error("This window has no clipboard."));
  if (typeof ClipboardItem === "function" && typeof clipboard.write === "function") {
    const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
    return clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  }
  return text.then((value) => clipboard.writeText(value));
}

/** Hands the files a person chose to the page's file chooser, one upload each. */
export async function answerChooser(threadId: string, tabId: string, files: File[]): Promise<void> {
  const base = tabBase(threadId, tabId);
  const ids: string[] = [];
  for (const file of files) {
    const response = await bytesRequest("POST", `${base}/uploads?name=${q(file.name)}`, file);
    ids.push(((await response.json()) as PreviewUpload).id);
  }
  await request("POST", `${base}/chooser`, { files: ids });
}

/** Saves a finished download where the person's browser saves files. */
export async function saveDownload(threadId: string, tabId: string, download: PreviewDownload): Promise<void> {
  const response = await bytesRequest("GET", `${tabBase(threadId, tabId)}/downloads/${q(download.id)}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = download.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The page's open file chooser and its downloads, each waiting on the person. */
export function PageBridge({ threadId, tab, onChanged }: { threadId: string; tab: PreviewTab; onChanged(): void }) {
  const picker = useRef<HTMLInputElement>(null);
  const pushToast = useUi((state) => state.pushToast);
  const downloads = tab.downloads ?? [];
  const failed = (what: string) => (failure: unknown) => pushToast(`${what} ${toFailure(failure).message}`);
  const answer = (files: File[]) =>
    answerChooser(threadId, tab.id, files).then(onChanged, failed("Couldn't give the page that file."));
  if (!tab.file_chooser && downloads.length === 0) return null;
  return (
    <div className="browser-bridge">
      {tab.file_chooser ? (
        <div className="browser-bridge-row" role="group" aria-label="File chooser">
          <span>The page asks for {tab.file_chooser === "many" ? "files" : "a file"}.</span>
          <input
            ref={picker}
            type="file"
            hidden
            aria-label="Files for the page"
            multiple={tab.file_chooser === "many"}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              if (files.length > 0) void answer(files);
            }}
          />
          <button type="button" onClick={() => picker.current?.click()}>
            Choose {tab.file_chooser === "many" ? "files" : "file"}
          </button>
          <button type="button" onClick={() => void answer([])}>
            Cancel
          </button>
        </div>
      ) : null}
      {downloads.length > 0 ? (
        <ul className="browser-bridge-row" aria-label="Downloads">
          {downloads.map((download) => (
            <li key={download.id}>
              <span>{download.name}</span>
              <span>
                {download.state === "done" ? size(download.bytes) : download.state === "stopped" ? "Stopped" : "Downloading..."}
              </span>
              {download.state === "done" ? (
                <button
                  type="button"
                  onClick={() => void saveDownload(threadId, tab.id, download).catch(failed("Couldn't save the download."))}
                >
                  Save
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
