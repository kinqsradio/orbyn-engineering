import { useState } from "react";
import { ApiFailure } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { ErrorState, Loading } from "../../ui/states";
import { BytesFallback, rawUrl } from "./FileMedia";
import { MAX_ARCHIVE_BYTES, formatBytes } from "./zipArchive";
import {
  MAX_COLUMNS_PER_SHEET,
  MAX_ROWS_PER_SHEET,
  type DocxBlock,
  type DocxDocument,
  type OfficeKind,
  type OfficeRequest,
  type OfficeResponse,
  type OfficeSheet,
  type XlsxDocument,
} from "./office";

/**
 * The Word and spreadsheet formats this viewer opens, by name. `.docm` and
 * `.xlsm` carry the same parts as `.docx` and `.xlsx`; the legacy `.doc` and
 * `.xls` are different binary formats and are not read here.
 */
export function officeKind(path: string): OfficeKind | null {
  if (/\.(docx|docm)$/i.test(path)) return "docx";
  if (/\.(xlsx|xlsm)$/i.test(path)) return "xlsx";
  return null;
}

/** How the viewer gets a model: the worker in the app, or a test's own reader. */
export type OfficeRun = (request: OfficeRequest, signal: AbortSignal) => Promise<OfficeResponse>;

/** How long one read may take before the worker is stopped and said to be stuck. */
export const OFFICE_READ_TIMEOUT_MS = 30_000;

/**
 * One worker per read, so parsing a large document cannot block typing. The
 * worker owns the bytes — the buffer is transferred rather than copied, which
 * is why it arrives without a second copy of a file that may be tens of
 * megabytes — and answers once; aborting an unmounted read stops it.
 *
 * A browser that gives this page no worker at all says so in its own words,
 * and a worker that never answers is stopped at the watchdog: either way the
 * panel ends in an error state with a Retry rather than reading forever.
 */
export function runInWorker(request: OfficeRequest, signal: AbortSignal): Promise<OfficeResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let worker: Worker;
    try {
      if (typeof Worker === "undefined") throw new Error("no Worker");
      worker = new Worker(new URL("./office.worker.ts", import.meta.url), { type: "module" });
    } catch {
      // No Worker, or a worker-src policy that refuses this one: the document
      // cannot be read on this page, which is not an unexpected failure.
      reject(
        new ApiFailure(
          "office_unsupported",
          "This browser can't read documents here. It has no background worker, or this page is not allowed to start one.",
          0,
        ),
      );
      return;
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    /** The one place a read ends, so the timer and the worker are let go once. */
    const settle = (finish: () => void) => {
      if (watchdog !== undefined) clearTimeout(watchdog);
      watchdog = undefined;
      signal.removeEventListener("abort", stop);
      worker.terminate();
      finish();
    };
    const stop = () => settle(() => reject(new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", stop, { once: true });
    watchdog = setTimeout(() => {
      settle(() =>
        reject(
          new ApiFailure(
            "office_timeout",
            `The document reader didn't answer within ${Math.round(OFFICE_READ_TIMEOUT_MS / 1000)} seconds, so it was stopped.`,
            0,
          ),
        ),
      );
    }, OFFICE_READ_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<OfficeResponse>) => {
      settle(() => resolve(event.data));
    });
    worker.addEventListener("error", () => {
      settle(() => reject(new ApiFailure("worker_stopped", "The document reader stopped before it finished.", 0)));
    });
    // Nothing on this thread reads these bytes again, so the worker takes the
    // buffer itself instead of a structured-cloned copy of it.
    worker.postMessage(request, [request.bytes.buffer]);
  });
}

/**
 * One block of a Word body. An app page already carries its own h1, so a
 * document's level 1 to 4 becomes h2 to h5 and the order still reads.
 */
function Block({ block }: { block: DocxBlock }) {
  if (block.kind === "heading") {
    const { text } = block;
    if (block.level === 1) return <h2 className="office-heading" data-level={1}>{text}</h2>;
    if (block.level === 2) return <h3 className="office-heading" data-level={2}>{text}</h3>;
    if (block.level === 3) return <h4 className="office-heading" data-level={3}>{text}</h4>;
    return <h5 className="office-heading" data-level={4}>{text}</h5>;
  }
  if (block.kind === "paragraph") return <p className="office-para">{block.text}</p>;
  if (block.rows.length === 0) return null;
  return (
    <div className="office-table" tabIndex={0} role="group" aria-label="Table">
      <table>
        <tbody>
          {block.rows.map((row, at) => (
            <tr key={at}>
              {row.map((cell, column) => (
                <td key={column}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocxBody({ document, path }: { document: DocxDocument; path: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return (
    <div className="office-doc">
      <div className="file-modes segment" role="radiogroup" aria-label="Document view">
        <button type="button" role="radio" aria-checked={mode === "preview"} onClick={() => setMode("preview")}>
          Preview
        </button>
        <button type="button" role="radio" aria-checked={mode === "source"} onClick={() => setMode("source")}>
          Source
        </button>
      </div>
      {mode === "source" ? (
        <pre tabIndex={0} className="file-source" aria-label={`Contents of ${path}`}>
          {document.text}
        </pre>
      ) : (
        <div className="office-body">
          {document.blocks.length === 0 ? (
            <p className="muted office-empty">This document holds no text the viewer can show.</p>
          ) : (
            document.blocks.map((block, at) => <Block key={at} block={block} />)
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The refusals that mean the file is not the document the viewer expected, or
 * is too large to hand to a reader at all. The bytes are still there to look
 * at, so those refusals offer them instead of ending the panel.
 */
const NO_BYTES_LOST: ReadonlySet<string> = new Set([
  "office_unreadable",
  "zip_unreadable",
  "zip_too_large",
  "no_decompression",
  "entry_unsupported",
]);

/** What a sheet's own caps left out, said in the grid rather than in silence. */
function CutNotice({ sheet }: { sheet: OfficeSheet }) {
  const parts: string[] = [];
  if (sheet.rowsCut) parts.push(`the first ${MAX_ROWS_PER_SHEET} rows`);
  if (sheet.columnsCut) parts.push(`the first ${MAX_COLUMNS_PER_SHEET} columns`);
  if (parts.length === 0) return null;
  return (
    <p className="office-note">
      Showing {parts.join(" and ")} of &quot;{sheet.name}&quot;; the rest is not shown.
    </p>
  );
}

/** The grid's column label: A, B, ... Z, AA. */
export function columnName(index: number): string {
  let name = "";
  let left = index + 1;
  while (left > 0) {
    name = String.fromCharCode(65 + ((left - 1) % 26)) + name;
    left = Math.floor((left - 1) / 26);
  }
  return name;
}

/** A worksheet's used range, read only, with its header row pinned. */
function BookBody({ book }: { book: XlsxDocument }) {
  const [selected, setSelected] = useState(0);
  const sheet = book.sheets[Math.min(selected, book.sheets.length - 1)];
  if (!sheet) return null;
  const width = sheet.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return (
    <div className="office-book">
      <div className="segment office-tabs" role="tablist" aria-label="Sheets">
        {book.sheets.map((each, at) => (
          <button key={at} type="button" role="tab" aria-selected={each === sheet} onClick={() => setSelected(at)}>
            {each.name}
          </button>
        ))}
      </div>
      <CutNotice sheet={sheet} />
      <div className="office-grid" role="tabpanel" aria-label={sheet.name}>
        {sheet.rows.length === 0 ? (
          <p className="muted office-empty">This sheet is empty.</p>
        ) : (
          <table>
            <thead>
              <tr>
                {Array.from({ length: width }, (_, column) => (
                  <th key={column} scope="col">
                    {columnName(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, at) => (
                <tr key={at}>
                  {Array.from({ length: width }, (_, column) => (
                    <td key={column}>{row[column] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * A Word document or a spreadsheet, read from its own bytes through the archive
 * reader and parsed off the main thread. Nothing is written back, and the
 * document's own markup is never inserted as HTML.
 */
export function DocumentViewer({
  threadId,
  path,
  kind,
  size,
  run = runInWorker,
}: {
  threadId: string;
  path: string;
  kind: OfficeKind;
  /**
   * The file's size, as the panel already knows it. A document past the archive
   * cap is refused from that number, before any of it is downloaded.
   */
  size?: number;
  /** The worker in the app; a test passes its own reader instead. */
  run?: OfficeRun;
}) {
  const noun = kind === "docx" ? "document" : "spreadsheet";
  const document = useAsync(`office:${threadId}:${path}:${kind}`, async (signal): Promise<OfficeResponse> => {
    if (size !== undefined && size > MAX_ARCHIVE_BYTES) {
      return {
        ok: false,
        code: "zip_too_large",
        message: `This ${noun} is ${formatBytes(size)}; the viewer opens at most ${formatBytes(MAX_ARCHIVE_BYTES)}.`,
      };
    }
    const response = await fetch(rawUrl(threadId, path), { credentials: "same-origin", signal });
    if (!response.ok) {
      throw new ApiFailure(`http_${response.status}`, `The service answered ${response.status}.`, response.status);
    }
    return run({ kind, bytes: new Uint8Array(await response.arrayBuffer()) }, signal);
  });

  if (document.status === "loading") return <Loading label={`Reading ${noun}`} rows={6} />;
  if (document.status === "error") {
    return (
      <ErrorState compact title={`Couldn't read this ${noun}`} failure={document.error} onRetry={document.reload} />
    );
  }
  const answer = document.data;
  if (!answer.ok) {
    const refusal = (
      <ErrorState
        compact
        title={`Couldn't read this ${noun}`}
        failure={new ApiFailure(answer.code, answer.message, 0)}
        onRetry={document.reload}
      />
    );
    if (size === undefined || !NO_BYTES_LOST.has(answer.code)) return refusal;
    return (
      <div className="office-refusal">
        {refusal}
        <BytesFallback threadId={threadId} path={path} size={size} />
      </div>
    );
  }
  return answer.model.format === "docx" ? (
    <DocxBody document={answer.model} path={path} />
  ) : (
    <BookBody book={answer.model} />
  );
}