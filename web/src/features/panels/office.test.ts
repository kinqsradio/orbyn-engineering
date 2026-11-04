import { expect, it } from "vitest";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  formatBytes,
} from "./zipArchive";
import {
  MAX_BLOCKS,
  MAX_PART_BYTES,
  OfficeError,
  parseDocx,
  respondToOfficeRequest,
  type DocxDocument,
  type OfficeKind,
  type OfficeParts,
} from "./office";
import { buildDocx, buildOfficePackage, docxParagraph } from "./office.test-support";

/** The model of a Word document the reader accepted. */
async function read(bytes: Uint8Array<ArrayBuffer>): Promise<DocxDocument> {
  const answer = await respondToOfficeRequest({ kind: "docx", bytes });
  if (!answer.ok) throw new Error(`Expected a document, got ${answer.code}: ${answer.message}`);
  if (answer.model.format !== "docx") throw new Error("Expected a Word document.");
  return answer.model;
}

/** The refusal the reader answered with, for a document it rejected. */
async function refused(bytes: Uint8Array<ArrayBuffer>): Promise<{ code: string; message: string }> {
  const answer = await respondToOfficeRequest({ kind: "docx", bytes });
  if (answer.ok) throw new Error("Expected this document to be refused.");
  return answer;
}

/** The error the parser itself raised. */
async function refusal(promise: Promise<unknown>): Promise<OfficeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OfficeError) return error;
    throw error;
  }
  throw new Error("Expected this document to be refused.");
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

it("refuses a part past the part cap with the cap it hit", async () => {
  const parts: OfficeParts = {
    names: ["word/document.xml"],
    read: async () => new Uint8Array(MAX_PART_BYTES + 1),
  };
  const error = await refusal(parseDocx(parts));
  expect(error.code).toBe("office_part_too_large");
  expect(error.message).toBe(
    `This document's word/document.xml is ${formatBytes(MAX_PART_BYTES + 1)}; the viewer reads at most ${formatBytes(MAX_PART_BYTES)} of one part.`,
  );
});

it("refuses a part the archive reader will not decompress, with the entry cap it hit", async () => {
  const answer = await refused(buildOfficePackage({ "word/document.xml": "x".repeat(MAX_ENTRY_BYTES + 1) }));
  expect(answer.code).toBe("entry_too_large");
  expect(answer.message).toContain(`at most ${formatBytes(MAX_ENTRY_BYTES)} of an entry`);
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
