import { vi } from "vitest";
import { METHOD_DEFLATED } from "./zipArchive";
import { buildZipArchive, type ZipSpec } from "./zipArchive.test-support";
import { respondToOfficeRequest, type OfficeRequest, type OfficeResponse } from "./office";

const XML_DECLARATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

/** The package parts a real file always carries; this reader never looks at them. */
const CONTENT_TYPES = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SPREADSHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOCUMENT_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";

/**
 * A real Open XML package: a zip whose parts are the XML written here, built by
 * the same hand-written fixture the archive tests use, so these bytes are a
 * document rather than a description of one.
 */
export function buildOfficePackage(parts: Record<string, string>): Uint8Array<ArrayBuffer> {
  const specs: ZipSpec[] = [
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8"), method: METHOD_DEFLATED },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8"), method: METHOD_DEFLATED },
    ...Object.entries(parts).map(
      ([name, xml]): ZipSpec => ({ name, data: Buffer.from(xml, "utf8"), method: METHOD_DEFLATED }),
    ),
  ];
  return buildZipArchive(specs);
}

/** A Word document whose body holds exactly the markup given. */
export function buildDocx(body: string): Uint8Array<ArrayBuffer> {
  return buildOfficePackage({
    "word/document.xml": `${XML_DECLARATION}<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}</w:body></w:document>`,
  });
}

/** A paragraph whose one run holds the text given. */
export function docxParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** A worksheet part whose rows are exactly the markup given. */
export function worksheet(rows: string): string {
  return `${XML_DECLARATION}<worksheet xmlns="${SPREADSHEET_NAMESPACE}"><sheetData>${rows}</sheetData></worksheet>`;
}

/**
 * The workbook and relationship parts that name the sheets given, one part
 * each. `targets` overrides the relationship target of a sheet, for a package
 * that names a part somewhere else or does not carry it at all.
 */
export function workbookParts(
  sheets: readonly { name: string; xml: string }[],
  targets?: readonly string[],
): Record<string, string> {
  const target = (at: number) => targets?.[at] ?? `worksheets/sheet${at + 1}.xml`;
  const parts: Record<string, string> = {
    "xl/workbook.xml": `${XML_DECLARATION}<workbook xmlns="${SPREADSHEET_NAMESPACE}" xmlns:r="${DOCUMENT_RELATIONSHIPS}"><sheets>${sheets
      .map((sheet, at) => `<sheet name="${sheet.name}" sheetId="${at + 1}" r:id="rId${at + 1}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">${sheets
      .map(
        (_, at) =>
          `<Relationship Id="rId${at + 1}" Type="${DOCUMENT_RELATIONSHIPS}/worksheet" Target="${target(at)}"/>`,
      )
      .join("")}</Relationships>`,
  };
  for (const [at, sheet] of sheets.entries()) parts[`xl/${target(at)}`] = sheet.xml;
  return parts;
}

/** A spreadsheet package: one part per sheet, and shared strings when given. */
export function buildXlsx(
  sheets: readonly { name: string; xml: string }[],
  sharedStrings?: readonly string[],
): Uint8Array<ArrayBuffer> {
  const parts = workbookParts(sheets);
  if (sharedStrings) {
    parts["xl/sharedStrings.xml"] =
      `${XML_DECLARATION}<sst xmlns="${SPREADSHEET_NAMESPACE}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
      sharedStrings.map((value) => `<si><t xml:space="preserve">${value}</t></si>`).join("") +
      `</sst>`;
  }
  return buildOfficePackage(parts);
}

/**
 * A stand-in for the browser's Worker: it answers with the very function the
 * worker body calls, so a component test exercises the protocol without a
 * second thread. jsdom has no Worker at all, which is why the viewer also takes
 * its reader as a parameter.
 */
export function stubWorker(): void {
  class FakeWorker {
    private readonly listeners = new Set<(event: { data: OfficeResponse }) => void>();

    constructor(_url: URL, _options?: unknown) {}

    addEventListener(type: string, listener: (event: { data: OfficeResponse }) => void): void {
      if (type === "message") this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: (event: { data: OfficeResponse }) => void): void {
      if (type === "message") this.listeners.delete(listener);
    }

    terminate(): void {}

    async postMessage(request: OfficeRequest): Promise<void> {
      const data = await respondToOfficeRequest(request);
      for (const listener of [...this.listeners]) listener({ data });
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
}
