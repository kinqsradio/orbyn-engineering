import { expect, it } from "vitest";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  formatBytes,
} from "./zipArchive";
import {
  MAX_BLOCKS,
  MAX_CELLS,
  MAX_ROWS_PER_SHEET,
  MAX_SHEETS,
  cellPosition,
  respondToOfficeRequest,
  type DocxDocument,
  type OfficeKind,
  type XlsxDocument,
} from "./office";
import { buildDocx, buildOfficePackage, buildXlsx, docxParagraph, workbookParts, worksheet } from "./office.test-support";

/** The model of a Word document the reader accepted. */
async function read(bytes: Uint8Array<ArrayBuffer>): Promise<DocxDocument> {
  const answer = await respondToOfficeRequest({ kind: "docx", bytes });
  if (!answer.ok) throw new Error(`Expected a document, got ${answer.code}: ${answer.message}`);
  if (answer.model.format !== "docx") throw new Error("Expected a Word document.");
  return answer.model;
}

/** The model of a workbook the reader accepted. */
async function readWorkbook(bytes: Uint8Array<ArrayBuffer>): Promise<XlsxDocument> {
  const answer = await respondToOfficeRequest({ kind: "xlsx", bytes });
  if (!answer.ok) throw new Error(`Expected a workbook, got ${answer.code}: ${answer.message}`);
  if (answer.model.format !== "xlsx") throw new Error("Expected a spreadsheet.");
  return answer.model;
}

/** The refusal the reader answered with, for a document it rejected. */
async function refused(
  bytes: Uint8Array<ArrayBuffer>,
  kind: OfficeKind = "docx",
): Promise<{ code: string; message: string }> {
  const answer = await respondToOfficeRequest({ kind, bytes });
  if (answer.ok) throw new Error("Expected this document to be refused.");
  return answer;
}

it("reads headings, paragraphs and tables in the order the body gives them", async () => {
  const model = await read(
    buildDocx(
      [
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly plan</w:t></w:r></w:p>`,
        `<w:p><w:r><w:t>First </w:t></w:r><w:r><w:t xml:space="preserve">draft &amp; notes</w:t></w:r></w:p>`,
        `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>` +
          `<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
        `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>`,
      ].join(""),
    ),
  );
  expect(model.blocks).toEqual([
    { kind: "heading", level: 1, text: "Quarterly plan" },
    { kind: "paragraph", text: "First draft & notes" },
    { kind: "table", rows: [["Region", "Sales"], ["North", "12"]], text: "Region\tSales\nNorth\t12" },
    { kind: "heading", level: 3, text: "Details" },
  ]);
  expect(model.text).toBe("Quarterly plan\nFirst draft & notes\nRegion\tSales\nNorth\t12\nDetails");
});

it("shows a heading deeper than four at the deepest level, and a named style stays a paragraph", async () => {
  const model = await read(
    buildDocx(
      `<w:p><w:pPr><w:pStyle w:val="Heading9"/></w:pPr><w:r><w:t>Deep</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Quoted</w:t></w:r></w:p>`,
    ),
  );
  expect(model.blocks).toEqual([
    { kind: "heading", level: 4, text: "Deep" },
    { kind: "paragraph", text: "Quoted" },
  ]);
});

it("keeps a tab and a line break inside a paragraph", async () => {
  const model = await read(buildDocx(`<w:p><w:r><w:t>one</w:t><w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t></w:r></w:p>`));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "one\ttwo\nthree" }]);
});

it("reads a paragraph inside a content control", async () => {
  const model = await read(buildDocx(`<w:sdt><w:sdtContent>${docxParagraph("In a control")}</w:sdtContent></w:sdt>`));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "In a control" }]);
});

it("flattens a table nested inside a cell", async () => {
  const model = await read(
    buildDocx(
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>` +
        `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc>` +
        `<w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`,
    ),
  );
  expect(model.blocks).toEqual([{ kind: "table", rows: [["outer\ninner\tcell"]], text: "outer\ninner\tcell" }]);
});

it("reads a table row the body wraps in a content control", async () => {
  // Word writes a repeating row as `<w:sdt><w:sdtContent><w:tr>`.
  const model = await read(
    buildDocx(
      `<w:tbl>` +
        `<w:sdt><w:sdtPr><w:tblHeader/></w:sdtPr><w:sdtContent>` +
        `<w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>` +
        `</w:sdtContent></w:sdt>` +
        `<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr>` +
        `</w:tbl>`,
    ),
  );
  expect(model.blocks).toEqual([
    { kind: "table", rows: [["Region", "Sales"], ["North", "12"]], text: "Region\tSales\nNorth\t12" },
  ]);
});

it("leaves the text of a deleted run out and keeps an inserted one", async () => {
  const model = await read(
    buildDocx(`<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>`),
  );
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "added" }]);
});

it("strips control characters from every string it shows", async () => {
  const model = await read(buildDocx(`<w:p><w:r><w:t>a\u0001b\u0007c\u009fd</w:t></w:r></w:p>`));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "abcd" }]);
});

it("keeps a line break and a tab a workbook cell holds", async () => {
  // The shape a real writer produces: openpyxl puts the cell's text in the
  // shared string part and writes its line break as `&#10;`, and Excel writes
  // the same for Alt+Enter.
  const model = await readWorkbook(
    buildXlsx(
      [
        {
          name: "Notes",
          xml: worksheet(
            `<row r="1"><c r="A1" t="s"><v>0</v></c>` +
              `<c r="B1" t="inlineStr"><is><t xml:space="preserve">plain&#9;tabbed</t></is></c></row>`,
          ),
        },
      ],
      ["line one&#10;line two"],
    ),
  );
  expect(model.sheets).toEqual([{ name: "Notes", rows: [["line one\nline two", "plain\ttabbed"]] }]);
});

it("takes a text box's text from one branch of an alternate content block", async () => {
  const alternate =
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice Requires="wps"><w:drawing><w:txbxContent>${docxParagraph("Inside the box")}</w:txbxContent></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><w:txbxContent>${docxParagraph("Inside the box")}</w:txbxContent></w:pict></mc:Fallback>` +
    `</mc:AlternateContent>`;
  const model = await read(buildDocx(`<w:p><w:r><w:t>before</w:t></w:r><w:r>${alternate}</w:r><w:r><w:t>after</w:t></w:r></w:p>`));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "beforeInside the boxafter" }]);
});

it("does not print a body-level alternate content block twice either", async () => {
  const alternate =
    `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<mc:Choice Requires="wps">${docxParagraph("Chosen")}</mc:Choice>` +
    `<mc:Fallback>${docxParagraph("Chosen")}</mc:Fallback>` +
    `</mc:AlternateContent>`;
  const model = await read(buildDocx(alternate));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "Chosen" }]);
});

it("reads what a damaged part still holds", async () => {
  const model = await read(buildOfficePackage({ "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>cut` }));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "cut" }]);
});

it("finds a part whatever case the package names it in", async () => {
  const model = await read(buildOfficePackage({ "Word/Document.xml": `<w:document><w:body>${docxParagraph("Case")}</w:body></w:document>` }));
  expect(model.blocks).toEqual([{ kind: "paragraph", text: "Case" }]);
});

it("refuses a document past the block cap with the cap it hit", async () => {
  const answer = await refused(buildDocx(docxParagraph("x").repeat(MAX_BLOCKS + 1)));
  expect(answer.code).toBe("office_too_many_blocks");
  expect(answer.message).toBe(
    `This document holds more than ${MAX_BLOCKS} paragraphs and tables; the viewer shows at most ${MAX_BLOCKS}.`,
  );
});

it("refuses an oversized part with the archive reader's entry cap, naming the part", async () => {
  // The archive reader's 2 MiB entry cap is the one that fires: the reader
  // asks it for every part, so no separate per-part branch can be reached.
  const answer = await refused(buildOfficePackage({ "word/document.xml": "x".repeat(MAX_ENTRY_BYTES + 1) }));
  expect(answer.code).toBe("entry_too_large");
  expect(answer.message).toBe(
    `This document's word/document.xml can't be read. This entry is ${formatBytes(MAX_ENTRY_BYTES + 1)}; the viewer reads at most ${formatBytes(MAX_ENTRY_BYTES)} of an entry.`,
  );
});

it("refuses a document over the archive cap the way an archive is refused", async () => {
  const answer = await refused(new Uint8Array(MAX_ARCHIVE_BYTES + 1));
  expect(answer.code).toBe("zip_too_large");
  expect(answer.message).toContain(`the viewer opens at most ${formatBytes(MAX_ARCHIVE_BYTES)}`);
});

it("refuses bytes that are not a package at all, with the archive's own reason", async () => {
  const answer = await refused(new Uint8Array(Buffer.from("not a package at all")));
  expect(answer.code).toBe("zip_unreadable");
  expect(answer.message).toContain("no zip central directory");
});

it("refuses a package that holds no Word body", async () => {
  const answer = await refused(buildOfficePackage({ "xl/workbook.xml": "<workbook/>" }));
  expect(answer.code).toBe("office_unreadable");
  expect(answer.message).toContain("no word/document.xml");
});

it("answers a kind it does not know with a refusal rather than a throw", async () => {
  const answer = await respondToOfficeRequest({ kind: "pptx" as unknown as OfficeKind, bytes: new Uint8Array(0) });
  expect(answer).toEqual({
    ok: false,
    code: "office_unreadable",
    message: "The viewer can't read pptx files.",
  });
});

it("reads a cell reference only when it is one", () => {
  expect(cellPosition("A1")).toEqual({ row: 1, column: 1 });
  expect(cellPosition(" ab12 ")).toEqual({ row: 12, column: 28 });
  expect(cellPosition("A0")).toBeNull();
  expect(cellPosition("1A")).toBeNull();
  expect(cellPosition("ABCD1")).toBeNull();
  expect(cellPosition("")).toBeNull();
});

it("reads a workbook's sheets with their shared strings, numbers, booleans and a cached formula", async () => {
  const model = await readWorkbook(
    buildXlsx(
      [
        {
          name: "Sales",
          xml: worksheet(
            `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
              `<row r="2"><c r="A2"><v>12</v></c><c r="B2" t="inlineStr"><is><t>note</t></is></c></row>` +
              `<row r="3"><c r="A3"><f>SUM(A2:A2)</f><v>12</v></c><c r="B3" t="b"><v>1</v></c></row>`,
          ),
        },
        { name: "Later", xml: worksheet(`<row r="1"><c r="A1"><v>2.5</v></c></row>`) },
        { name: "Blank", xml: worksheet("") },
      ],
      ["Region", "Total"],
    ),
  );
  expect(model.sheets).toEqual([
    { name: "Sales", rows: [["Region", "Total"], ["12", "note"], ["12", "TRUE"]] },
    { name: "Later", rows: [["2.5"]] },
    { name: "Blank", rows: [] },
  ]);
});

it("places a cell where its own reference says, counting rows from 1 and columns from A", async () => {
  const model = await readWorkbook(buildXlsx([{ name: "Placed", xml: worksheet(`<row r="5"><c r="D5"><v>7</v></c></row>`) }]));
  // The four empty rows above the value keep its position, and a row is not
  // padded out to the sheet's widest column: the grid's own width does that.
  expect(model.sheets[0]?.rows).toEqual([[], [], [], [], ["", "", "", "7"]]);
});

it("skips a malformed or impossible reference and keeps reading the row", async () => {
  const model = await readWorkbook(
    buildXlsx([
      {
        name: "Skipped",
        xml: worksheet(
          `<row r="1"><c r="A1"><v>1</v></c><c r="B"></c><c r="1C"><v>9</v></c><c r="A0"><v>8</v></c>` +
            `<c r="AAAA1"><v>7</v></c><c><v>5</v></c></row>`,
        ),
      },
    ]),
  );
  // The cell with no reference at all follows the cell before it.
  expect(model.sheets[0]?.rows).toEqual([["1", "5"]]);
});

it("shows an index past the shared strings, and a formula with no cached value, as nothing", async () => {
  const model = await readWorkbook(
    buildXlsx(
      [{ name: "Sparse", xml: worksheet(`<row r="1"><c r="A1" t="s"><v>9</v></c><c r="B1"><f>1+1</f></c></row>`) }],
      ["only"],
    ),
  );
  expect(model.sheets[0]?.rows).toEqual([]);
});

it("numbers rows one after another when the markup does not say", async () => {
  const model = await readWorkbook(
    buildXlsx([{ name: "Unnumbered", xml: worksheet(`<row><c r="A1"><v>1</v></c></row><row><c><v>2</v></c></row>`) }]),
  );
  expect(model.sheets[0]?.rows).toEqual([["1"], ["2"]]);
});

it("strips control characters from a sheet name and a cell", async () => {
  const model = await readWorkbook(
    buildXlsx([
      { name: "Tab\u0001le", xml: worksheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>a\u0007b</t></is></c></row>`) },
    ]),
  );
  expect(model.sheets).toEqual([{ name: "Table", rows: [["ab"]] }]);
});

it("labels a sheet that carries no name by its position", async () => {
  const model = await readWorkbook(buildXlsx([{ name: "", xml: worksheet(`<row r="1"><c r="A1"><v>1</v></c></row>`) }]));
  expect(model.sheets).toEqual([{ name: "Sheet 1", rows: [["1"]] }]);
});

it("follows the relationship target a workbook names its sheet by", async () => {
  const model = await readWorkbook(
    buildOfficePackage(
      workbookParts(
        [{ name: "Custom", xml: worksheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Custom</t></is></c></row>`) }],
        ["worksheets/tab.xml"],
      ),
    ),
  );
  expect(model.sheets).toEqual([{ name: "Custom", rows: [["Custom"]] }]);
});

it("keeps a sheet whose part is there and skips one whose part is not", async () => {
  const parts = workbookParts(
    [
      { name: "Kept", xml: worksheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Kept</t></is></c></row>`) },
      { name: "Gone", xml: worksheet(`<row r="1"><c r="A1"><v>2</v></c></row>`) },
    ],
    ["worksheets/sheet1.xml", "worksheets/missing.xml"],
  );
  delete parts["xl/worksheets/missing.xml"];
  const model = await readWorkbook(buildOfficePackage(parts));
  expect(model.sheets).toEqual([{ name: "Kept", rows: [["Kept"]] }]);
});

it("shows the rows of a sheet that fit and marks the rest as cut", async () => {
  const tall = MAX_ROWS_PER_SHEET + 1;
  const model = await readWorkbook(
    buildXlsx([
      {
        name: "Tall",
        xml: worksheet(`<row r="1"><c r="A1"><v>1</v></c></row><row r="${tall}"><c r="A${tall}"><v>2</v></c></row>`),
      },
    ]),
  );
  expect(model.sheets).toEqual([{ name: "Tall", rows: [["1"]], rowsCut: true }]);
});

it("shows the columns of a sheet that fit and marks the rest as cut", async () => {
  // BM is column 65, the first one past the cap.
  const model = await readWorkbook(
    buildXlsx([
      { name: "Wide", xml: worksheet(`<row r="1"><c r="A1"><v>1</v></c><c r="BM1"><v>2</v></c></row>`) },
    ]),
  );
  expect(model.sheets).toEqual([{ name: "Wide", rows: [["1"]], columnsCut: true }]);
});

it("marks neither a row nor a column cut when a sheet is inside both caps", async () => {
  const model = await readWorkbook(
    buildXlsx([{ name: "Fits", xml: worksheet(`<row r="${MAX_ROWS_PER_SHEET}"><c r="A1"><v>1</v></c></row>`) }]),
  );
  expect(model.sheets[0]?.rowsCut).toBeUndefined();
  expect(model.sheets[0]?.columnsCut).toBeUndefined();
});

it("keeps the cells one 200-sheet workbook lays out bounded", async () => {
  // The shape from issue #136: 61 KB, 200 sheets, each one cell at row 5000
  // column BL, which the old padding turned into 64,000,000 cells and a 194 MB
  // model. The whole workbook is now refused before the fourth sheet is laid
  // out, and the refusal names the budget.
  const sheets = Array.from({ length: MAX_SHEETS }, (_, at) => ({
    name: `S${at + 1}`,
    xml: worksheet(`<row r="${MAX_ROWS_PER_SHEET}"><c r="BL${MAX_ROWS_PER_SHEET}"><v>${at + 1}</v></c></row>`),
  }));
  const answer = await refused(buildXlsx(sheets), "xlsx");
  expect(answer.code).toBe("office_too_many_cells");
  expect(answer.message).toBe(
    `This workbook's grids add up to more than ${MAX_CELLS} cells; the viewer shows at most ${MAX_CELLS} across all its sheets.`,
  );
});

it("reads a workbook whose grids stay inside the whole-workbook budget", async () => {
  const sheets = Array.from({ length: MAX_SHEETS }, (_, at) => ({
    name: `S${at + 1}`,
    xml: worksheet(`<row r="1"><c r="A1"><v>${at + 1}</v></c></row>`),
  }));
  const model = await readWorkbook(buildXlsx(sheets));
  expect(model.sheets).toHaveLength(MAX_SHEETS);
  const shown = model.sheets.reduce((all, sheet) => all + sheet.rows.length * sheet.rows[0]!.length, 0);
  expect(shown).toBeLessThanOrEqual(MAX_CELLS);
});

it("refuses a workbook past the sheet cap with the cap it hit", async () => {
  const sheets = Array.from({ length: MAX_SHEETS + 1 }, (_, at) => ({ name: `S${at + 1}`, xml: worksheet("") }));
  const answer = await refused(buildXlsx(sheets), "xlsx");
  expect(answer.code).toBe("office_too_many_sheets");
  expect(answer.message).toBe(`This workbook names ${MAX_SHEETS + 1} sheets; the viewer shows at most ${MAX_SHEETS}.`);
});

it("refuses a package that holds no workbook", async () => {
  const answer = await refused(buildDocx(docxParagraph("Words only")), "xlsx");
  expect(answer.code).toBe("office_unreadable");
  expect(answer.message).toContain("no xl/workbook.xml");
});

it("refuses a workbook whose worksheets are all missing", async () => {
  const parts = workbookParts([{ name: "Gone", xml: worksheet("") }]);
  delete parts["xl/worksheets/sheet1.xml"];
  const answer = await refused(buildOfficePackage(parts), "xlsx");
  expect(answer.code).toBe("office_unreadable");
  expect(answer.message).toContain("worksheets are missing");
});
