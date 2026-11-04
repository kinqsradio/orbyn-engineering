import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentViewer, officeKind, runInWorker, type OfficeRun } from "./DocumentViewer";
import { MAX_ARCHIVE_BYTES, formatBytes } from "./zipArchive";
import { buildDocx, buildXlsx, docxParagraph, stubWorker, worksheet } from "./office.test-support";
import type { DocxDocument, OfficeModel, OfficeRequest, OfficeResponse, XlsxDocument } from "./office";

afterEach(() => vi.restoreAllMocks());

/** Serves one package over the raw route, whatever the address asks for. */
function serveFile(bytes: Uint8Array<ArrayBuffer>, status = 200) {
  const fetch = vi.fn(async (_input: string) => new Response(bytes.slice().buffer, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const model: DocxDocument = {
  format: "docx",
  blocks: [
    { kind: "heading", level: 1, text: "Quarterly plan" },
    { kind: "paragraph", text: "First draft." },
    { kind: "heading", level: 3, text: "Details" },
    { kind: "table", rows: [["Region", "Sales"], ["North", "12"]], text: "Region\tSales\nNorth\t12" },
  ],
  text: "Quarterly plan\nFirst draft.\nDetails\nRegion\tSales\nNorth\t12",
};

/** A reader that answers with a model, standing in for the worker. */
const answers = (given: OfficeModel): OfficeRun => async () => ({ ok: true, model: given });

const book: XlsxDocument = {
  format: "xlsx",
  sheets: [
    { name: "Sales", rows: [["Region", "Total"], ["North", "12"], ["South", "7"]] },
    { name: "Costs", rows: [["Item", "Cost"], ["Hosting", "3"]] },
  ],
};

const page = (run?: OfficeRun) => (
  <DocumentViewer threadId="t" path="plan.docx" kind="docx" run={run} />
);

it("renders a Word document's headings, paragraphs and table", async () => {
  serveFile(buildDocx(""));
  render(page(answers(model)));
  // An app page already owns its h1, so a level 1 heading is an h2 here.
  expect(await screen.findByRole("heading", { level: 2, name: "Quarterly plan" })).toHaveAttribute("data-level", "1");
  expect(screen.getByRole("heading", { level: 4, name: "Details" })).toHaveAttribute("data-level", "3");
  expect(screen.getByText("First draft.")).toBeInTheDocument();
  const table = within(screen.getByRole("group", { name: "Table" }));
  expect(table.getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Region", "Sales", "North", "12"]);
});

it("shows the flattened text as source", async () => {
  const user = userEvent.setup();
  serveFile(buildDocx(""));
  render(page(answers(model)));
  await screen.findByRole("heading", { name: "Quarterly plan" });

  await user.click(screen.getByRole("radio", { name: "Source" }));
  expect(screen.getByLabelText("Contents of plan.docx")).toHaveTextContent("First draft.");
  expect(screen.queryByRole("heading", { name: "Quarterly plan" })).toBeNull();

  await user.click(screen.getByRole("radio", { name: "Preview" }));
  expect(screen.getByRole("heading", { name: "Quarterly plan" })).toBeInTheDocument();
});

it("says so when a document holds no text", async () => {
  serveFile(buildDocx(""));
  render(page(answers({ format: "docx", blocks: [], text: "" })));
  expect(await screen.findByText("This document holds no text the viewer can show.")).toBeInTheDocument();
});

it("refuses an oversized document before it downloads a byte of it", async () => {
  const fetch = serveFile(buildDocx(""));
  render(
    <DocumentViewer
      threadId="t"
      path="huge.docx"
      kind="docx"
      size={MAX_ARCHIVE_BYTES + 1}
      run={answers(model)}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(`This document is ${formatBytes(MAX_ARCHIVE_BYTES + 1)}`);
  expect(alert).toHaveTextContent(`at most ${formatBytes(MAX_ARCHIVE_BYTES)}`);
  expect(fetch).not.toHaveBeenCalled();
});

it("hands the worker the file's own buffer instead of a copy", async () => {
  const transferred: Transferable[][] = [];
  class RecordingWorker {
    private readonly listeners = new Set<(event: { data: OfficeResponse }) => void>();

    constructor(_url: URL, _options?: unknown) {}

    addEventListener(type: string, listener: (event: { data: OfficeResponse }) => void): void {
      if (type === "message") this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: (event: { data: OfficeResponse }) => void): void {
      if (type === "message") this.listeners.delete(listener);
    }

    terminate(): void {}

    postMessage(_request: OfficeRequest, transfer: Transferable[] = []): void {
      transferred.push(transfer);
      for (const listener of [...this.listeners]) listener({ data: { ok: true, model } });
    }
  }
  vi.stubGlobal("Worker", RecordingWorker);
  const bytes = buildDocx(docxParagraph("Owned"));
  await runInWorker({ kind: "docx", bytes }, new AbortController().signal);
  expect(transferred).toEqual([[bytes.buffer]]);
});

it("hands the file's own bytes to the reader", async () => {
  const bytes = buildDocx(docxParagraph("Bytes"));
  serveFile(bytes);
  const seen: OfficeRequest[] = [];
  render(
    page(async (request) => {
      seen.push(request);
      return { ok: true, model };
    }),
  );
  await screen.findByRole("heading", { name: "Quarterly plan" });
  expect(seen[0]?.kind).toBe("docx");
  expect(seen[0]?.bytes.length).toBe(bytes.byteLength);
});

it("stays in the loading state until the reader answers", async () => {
  serveFile(buildDocx(""));
  let started = (): void => undefined;
  const reading = new Promise<void>((resolve) => (started = resolve));
  let answer = (_response: OfficeResponse): void => undefined;
  render(
    page(() => {
      started();
      return new Promise<OfficeResponse>((resolve) => (answer = resolve));
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Reading document");

  // Wait for the reader to be called, then answer it: nothing here is timed.
  await act(async () => reading);
  await act(async () => answer({ ok: true, model }));
  expect(screen.getByRole("heading", { level: 2, name: "Quarterly plan" })).toBeInTheDocument();
});

it("shows a refusal in the panel's error state with its own code", async () => {
  serveFile(buildDocx(""));
  render(
    page(async () => ({
      ok: false,
      code: "office_too_many_blocks",
      message: "This document holds more than 5000 paragraphs and tables; the viewer shows at most 5000.",
    })),
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't read this document");
  expect(alert).toHaveTextContent("This document holds more than 5000 paragraphs and tables");
  expect(alert).toHaveTextContent("office_too_many_blocks");
  expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

it("reports a raw route failure", async () => {
  serveFile(new Uint8Array(0), 500);
  render(page(answers(model)));
  expect(await screen.findByRole("alert")).toHaveTextContent("The service answered 500");
});

it("reads a real package through the worker's own protocol", async () => {
  stubWorker();
  serveFile(
    buildDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>From the worker</w:t></w:r></w:p>` +
        docxParagraph("A paragraph."),
    ),
  );
  render(page());
  expect(await screen.findByRole("heading", { level: 3, name: "From the worker" })).toBeInTheDocument();
  expect(screen.getByText("A paragraph.")).toBeInTheDocument();
});

it("reads the file through the raw route, which carries the token", async () => {
  const fetch = serveFile(buildDocx(""));
  sessionStorage.setItem("orbyn.token", "secret");
  render(page(answers(model)));
  await screen.findByRole("heading", { name: "Quarterly plan" });
  const [called] = fetch.mock.calls[0] ?? [];
  const url = new URL(String(called), "http://localhost");
  expect(url.pathname).toBe("/api/threads/t/files/raw");
  expect(url.searchParams.get("path")).toBe("plan.docx");
  expect(url.searchParams.get("token")).toBe("secret");
  sessionStorage.clear();
});

it("opens Word and spreadsheet by name and leaves the other formats alone", () => {
  expect(officeKind("a/plan.docx")).toBe("docx");
  expect(officeKind("PLAN.DOCM")).toBe("docx");
  expect(officeKind("book.xlsx")).toBe("xlsx");
  expect(officeKind("BOOK.XLSM")).toBe("xlsx");
  expect(officeKind("plan.doc")).toBeNull();
  expect(officeKind("book.xls")).toBeNull();
  expect(officeKind("deck.pptx")).toBeNull();
  expect(officeKind("data.csv")).toBeNull();
});

it("shows a workbook's sheets as tabs over one read-only grid", async () => {
  serveFile(buildXlsx([{ name: "Sales", xml: worksheet("") }]));
  render(<DocumentViewer threadId="t" path="book.xlsx" kind="xlsx" run={answers(book)} />);

  const tabs = within(await screen.findByRole("tablist")).getAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(["Sales", "Costs"]);
  expect(tabs[0]).toHaveAttribute("aria-selected", "true");

  const grid = screen.getByRole("tabpanel", { name: "Sales" });
  expect(within(grid).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["A", "B"]);
  expect(within(grid).getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "Region",
    "Total",
    "North",
    "12",
    "South",
    "7",
  ]);
});

it("switches to another sheet's grid", async () => {
  const user = userEvent.setup();
  serveFile(buildXlsx([{ name: "Sales", xml: worksheet("") }]));
  render(<DocumentViewer threadId="t" path="book.xlsx" kind="xlsx" run={answers(book)} />);
  await screen.findByRole("tab", { name: "Costs" });

  await user.click(screen.getByRole("tab", { name: "Costs" }));
  const grid = screen.getByRole("tabpanel", { name: "Costs" });
  expect(within(grid).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Item", "Cost", "Hosting", "3"]);
  expect(screen.getByRole("tab", { name: "Costs" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Sales" })).toHaveAttribute("aria-selected", "false");
});

it("says so when a sheet is empty", async () => {
  serveFile(buildXlsx([{ name: "Blank", xml: worksheet("") }]));
  render(
    <DocumentViewer
      threadId="t"
      path="book.xlsx"
      kind="xlsx"
      run={answers({ format: "xlsx", sheets: [{ name: "Blank", rows: [] }] })}
    />,
  );
  expect(await screen.findByText("This sheet is empty.")).toBeInTheDocument();
});

it("keeps a cell's own line break in the grid rather than collapsing it", async () => {
  serveFile(buildXlsx([{ name: "Notes", xml: worksheet("") }]));
  render(
    <DocumentViewer
      threadId="t"
      path="book.xlsx"
      kind="xlsx"
      run={answers({ format: "xlsx", sheets: [{ name: "Notes", rows: [["line one\nline two"]] }] })}
    />,
  );
  const cell = await screen.findByRole("cell", { name: /line one/ });
  // The grid's own style is `white-space: pre-wrap`, so the break is a second
  // line on screen; the text must reach it unbroken for that to work.
  expect(cell.textContent).toBe("line one\nline two");
});

it("shows a spreadsheet refusal under the spreadsheet's own title", async () => {
  serveFile(buildXlsx([{ name: "Tall", xml: worksheet("") }]));
  render(
    <DocumentViewer
      threadId="t"
      path="book.xlsx"
      kind="xlsx"
      run={async () => ({
        ok: false,
        code: "office_sheet_too_large",
        message: "The sheet \"Tall\" puts a value past row 5000; the viewer shows at most 5000 rows.",
      })}
    />,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Couldn't read this spreadsheet");
  expect(alert).toHaveTextContent("past row 5000");
  expect(alert).toHaveTextContent("office_sheet_too_large");
});

it("reads a real workbook through the worker's own protocol", async () => {
  stubWorker();
  serveFile(
    buildXlsx([
      { name: "Sheet", xml: worksheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>From the worker</t></is></c></row>`) },
    ]),
  );
  render(<DocumentViewer threadId="t" path="book.xlsx" kind="xlsx" />);
  expect(await screen.findByRole("cell", { name: "From the worker" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Sheet" })).toBeInTheDocument();
});