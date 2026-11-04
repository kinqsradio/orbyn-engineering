/**
 * A small reader for the parts of a zip archive the file viewer needs: the
 * central directory for the folder list, and one entry's bytes when it is
 * opened. It is deliberately hand-written: reading an archive must not add a
 * dependency, and the platform's own `DecompressionStream` covers deflate.
 *
 * It only reads. Nothing here writes a file, and an entry name is never turned
 * into a path on a disk: names are untrusted text, so they are cleaned for
 * display and then only used as text.
 */

/** The largest archive the viewer opens. */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** The most entries the viewer lists. */
export const MAX_ENTRIES = 2000;
/** The most an entry may hold before the viewer refuses to read it. */
export const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

export const METHOD_STORED = 0;
export const METHOD_DEFLATED = 8;

/** An end of central directory record plus the longest comment it may carry. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;
/** How deep the tree nests a name; deeper parts fold into the last row. */
const MAX_SEGMENTS = 32;
/** How much of an entry is searched for a NUL byte before it counts as binary. */
const SNIFF_BYTES = 8 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The 32-bit "look in a Zip64 record" marker. */
const ZIP64_MARKER = 0xffffffff;

/** One entry, as the central directory describes it. */
export interface ZipEntry {
  /** Display name: control characters stripped, no leading or trailing slash. */
  name: string;
  /** The whole name inside the archive, as the tree shows it. */
  path: string;
  isDirectory: boolean;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where this entry's local header is; its bytes follow the local name and extra. */
  localHeaderOffset: number;
  /** A general purpose flag bit 0 entry cannot be read without a password. */
  encrypted: boolean;
}

/** Why an archive was refused. Every one of these is shown to the person. */
export type ZipRefusal = "zip_too_large" | "zip_too_many_entries" | "zip64" | "zip_unreadable";

export type ZipReadResult =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; code: ZipRefusal; message: string };

/** A refusal to read one entry, with a message ready to show. */
export class ZipError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

/** Byte sizes a person reads: 512 B, 1.5 KB, 12 MB. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal only when the size has one: "12 MB", not "12.0 MB".
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} ${units[unit]}`;
}

const viewOf = (bytes: Uint8Array<ArrayBuffer>) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The offset of the end of central directory record, or -1 when there is none.
 *
 * A signature alone proves nothing: entry names, and a comment, are free text,
 * so a comment can carry a 22-byte record of its own and the first match going
 * backwards would win. The record is only trusted when the comment it declares
 * ends exactly at the end of the file, which no copy inside the file does. A
 * scan that finds no such record answers -1, so the caller refuses rather than
 * guesses at whichever signature happened to be last.
 */
export function findEndOfCentralDirectory(bytes: Uint8Array<ArrayBuffer>): number {
  if (bytes.length < 22) return -1;
  const view = viewOf(bytes);
  const oldest = Math.max(0, bytes.length - EOCD_SEARCH_BYTES);
  const newest = bytes.length - 22;
  for (let at = newest; at >= oldest; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    if (at + 22 + view.getUint16(at + 20, true) === bytes.length) return at;
  }
  return -1;
}

/**
 * The high half of code page 437, the encoding a zip entry without the UTF-8
 * flag was written in when it predates that flag. `TextDecoder` has no cp437,
 * so the table is here: 0x80 to 0xff, in order.
 */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

/** The legacy decoding for a name written before the UTF-8 flag existed. */
export function decodeCp437(bytes: Uint8Array<ArrayBuffer>): string {
  let text = "";
  for (const byte of bytes) {
    text += byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH[byte - 0x80] ?? "?");
  }
  return text;
}

/**
 * A name is UTF-8 when the entry says so. When it does not, strict UTF-8 is
 * tried first because many tools write UTF-8 without setting the flag, and
 * code page 437 is the honest fallback when those bytes are not valid UTF-8.
 */
export function decodeEntryName(raw: Uint8Array<ArrayBuffer>, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder("utf-8").decode(raw);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return decodeCp437(raw);
  }
}

/** Control characters and bidi overrides hide what a name really is. */
function isHidingCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** The name without the characters that would hide what it says. */
function visibleName(name: string): string {
  let shown = "";
  for (const character of name) {
    if (!isHidingCodePoint(character.codePointAt(0) ?? 0)) shown += character;
  }
  return shown;
}

/**
 * A name for a row, never a path: segments keep their order, empty ones and
 * `.`/`..` are dropped, and nothing here is ever joined into a path on a disk.
 */
export function sanitizeEntryName(name: string): string {
  return name
    .split("/")
    .map((segment) => visibleName(segment).trim())
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
}

/** Bytes with a NUL in them are not text, whatever the name says. */
export function looksBinary(bytes: Uint8Array<ArrayBuffer>): boolean {
  return bytes.subarray(0, SNIFF_BYTES).includes(0);
}

export function decodeEntryText(bytes: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder("utf-8").decode(bytes);
}

const unreadable = (message: string): ZipReadResult => ({ ok: false, code: "zip_unreadable", message });
const zip64Refused = (): ZipReadResult => ({
  ok: false,
  code: "zip64",
  message: "This archive is Zip64, so it is too large for this viewer.",
});

/**
 * The central directory of an archive, or the reason it was refused. The caps
 * are checked before anything is parsed, so a refusal costs one length check.
 */
export function readZipArchive(bytes: Uint8Array<ArrayBuffer>): ZipReadResult {
  if (bytes.length > MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      code: "zip_too_large",
      message: `This archive is ${formatBytes(bytes.length)}; the viewer opens at most ${formatBytes(MAX_ARCHIVE_BYTES)}.`,
    };
  }
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) {
    return unreadable("This file has no zip central directory, so the viewer can't read it as an archive.");
  }
  const view = viewOf(bytes);
  // A Zip64 archive ends with a locator just before the record.
  if (end >= 20 && view.getUint32(end - 20, true) === ZIP64_LOCATOR_SIGNATURE) return zip64Refused();
  const disk = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryAt = view.getUint32(end + 16, true);
  if (directorySize === ZIP64_MARKER || directoryAt === ZIP64_MARKER) return zip64Refused();
  if (entryCount > MAX_ENTRIES) {
    return {
      ok: false,
      code: "zip_too_many_entries",
      message: `This archive holds ${entryCount} entries; the viewer lists at most ${MAX_ENTRIES}.`,
    };
  }
  if (disk !== 0 || directoryDisk !== 0) {
    return unreadable("This archive is split over several files, which the viewer can't read.");
  }
  if (directoryAt + directorySize > bytes.length) {
    return unreadable("This archive's central directory is cut short.");
  }

  const entries: ZipEntry[] = [];
  let at = directoryAt;
  for (let index = 0; index < entryCount; index += 1) {
    if (at + 46 > bytes.length) return unreadable("This archive's central directory ends before its last entry.");
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) return unreadable("This archive's central directory is damaged.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localHeaderOffset = view.getUint32(at + 42, true);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      return zip64Refused();
    }
    if (at + 46 + nameLength > bytes.length) return unreadable("This archive's central directory is cut short.");
    const decoded = decodeEntryName(bytes.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0);
    const isDirectory = decoded.endsWith("/");
    const path = sanitizeEntryName(decoded);
    at += 46 + nameLength + extraLength + commentLength;
    // A name of nothing but separators has no row to live in; a nameless
    // directory has no children either, so it is dropped rather than invented.
    if (path === "" && isDirectory) continue;
    const name = path === "" ? "(unnamed)" : (path.split("/").at(-1) ?? path);
    entries.push({
      name,
      path: path === "" ? name : path,
      isDirectory,
      method,
      flags,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    });
  }
  return { ok: true, entries };
}

/** Where one entry's stored bytes begin, past its local header's name and extra. */
export function entryDataRange(bytes: Uint8Array<ArrayBuffer>, entry: ZipEntry): { start: number; length: number } {
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length) {
    throw new ZipError("entry_unreadable", "This entry's record is past the end of the archive.");
  }
  const view = viewOf(bytes);
  if (view.getUint32(header, true) !== LOCAL_SIGNATURE) {
    throw new ZipError("entry_unreadable", "This entry's local record is damaged.");
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  if (start + entry.compressedSize > bytes.length) {
    throw new ZipError("entry_unreadable", "This entry is cut short by the end of the archive.");
  }
  return { start, length: entry.compressedSize };
}

/** An entry's bytes exactly as the archive stores them. */
export function storedEntryBytes(bytes: Uint8Array<ArrayBuffer>, entry: ZipEntry): Uint8Array<ArrayBuffer> {
  const { start, length } = entryDataRange(bytes, entry);
  return bytes.subarray(start, start + length);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let at = 0; at < 256; at += 1) {
    let value = at;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[at] = value >>> 0;
  }
  return table;
})();

/** The CRC-32 a zip directory records for an entry. */
export function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function joinBytes(chunks: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const whole = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
}

/**
 * Deflate, with the platform's own decompressor. The cap is enforced while the
 * bytes stream, so an archive that claims a small entry but expands past the
 * cap is stopped before it is held in memory.
 */
async function inflateRaw(input: Uint8Array<ArrayBuffer>, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream !== "function") {
    throw new ZipError(
      "no_decompression",
      "This browser can't decompress deflated entries, so the viewer can't open them here.",
    );
  }
  const inflater = new DecompressionStream("deflate-raw");
  // The write and the read share one transform, so neither side waits on the
  // other: the compressed bytes go in while the expanded ones come out.
  const writer = inflater.writable.getWriter();
  const fed = writer
    .write(input)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = inflater.readable.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        throw new ZipError("entry_too_large", `This entry expands past the ${formatBytes(cap)} the viewer reads.`);
      }
      chunks.push(value);
    }
  } catch (failure) {
    if (failure instanceof ZipError) throw failure;
    throw new ZipError("entry_corrupt", "This entry can't be decompressed, so the archive may be damaged.");
  } finally {
    await fed;
  }
  return joinBytes(chunks);
}

/**
 * One entry's bytes, decompressed, with its checksum checked against the
 * directory. Everything that can refuse does so with a message ready to show.
 */
export async function readEntryBytes(
  bytes: Uint8Array<ArrayBuffer>,
  entry: ZipEntry,
  cap = MAX_ENTRY_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  if (entry.isDirectory) throw new ZipError("entry_is_directory", "This is a folder, not a file.");
  if (entry.encrypted) throw new ZipError("entry_encrypted", "This entry is encrypted, so the viewer can't read it.");
  if (entry.uncompressedSize > cap) {
    throw new ZipError(
      "entry_too_large",
      `This entry is ${formatBytes(entry.uncompressedSize)}; the viewer reads at most ${formatBytes(cap)} of an entry.`,
    );
  }
  const stored = storedEntryBytes(bytes, entry);
  let data: Uint8Array<ArrayBuffer>;
  if (entry.method === METHOD_STORED) data = stored.slice();
  else if (entry.method === METHOD_DEFLATED) data = await inflateRaw(stored, cap);
  else {
    throw new ZipError("entry_unsupported", `This entry uses compression method ${entry.method}, which the viewer can't read.`);
  }
  if (data.length > cap) throw new ZipError("entry_too_large", `This entry expands past the ${formatBytes(cap)} the viewer reads.`);
  if (data.length !== entry.uncompressedSize) {
    throw new ZipError("entry_corrupt", "This entry's size doesn't match the archive's directory.");
  }
  if (crc32(data) !== entry.crc32) {
    throw new ZipError("entry_corrupt", "This entry's contents don't match its checksum.");
  }
  return data;
}

/** One row of the tree: a directory to toggle, or a file to open. */
export interface ZipTreeNode {
  /** Unique within the tree, for React keys, even when two entries share a name. */
  key: string;
  name: string;
  path: string;
  isDirectory: boolean;
  /** The directory's own entry when the archive carries one; null for a folder that only exists in paths. */
  entry: ZipEntry | null;
  children: ZipTreeNode[];
}

const compareNames = (left: string, right: string) => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
};

function sortNodes(nodes: ZipTreeNode[]): ZipTreeNode[] {
  nodes.sort((left, right) =>
    left.isDirectory === right.isDirectory ? compareNames(left.name, right.name) : left.isDirectory ? -1 : 1,
  );
  for (const node of nodes) sortNodes(node.children);
  return nodes;
}

/**
 * A name can carry more separators than any real folder list nests. Past the
 * cap the rest folds into the last row, so a nonsensical name stays readable
 * instead of building thousands of levels.
 */
function foldSegments(segments: string[]): string[] {
  if (segments.length <= MAX_SEGMENTS) return segments;
  return [...segments.slice(0, MAX_SEGMENTS - 1), segments.slice(MAX_SEGMENTS - 1).join("/")];
}

/**
 * Entries nested by their `/` path, directories first, then files by name. A
 * path may name a folder the archive has no entry for, which becomes one.
 */
export function buildZipTree(entries: readonly ZipEntry[]): ZipTreeNode[] {
  const root: ZipTreeNode = { key: "", name: "", path: "", isDirectory: true, entry: null, children: [] };
  const duplicates = new Map<string, number>();
  for (const entry of entries) {
    const segments = foldSegments(entry.path.split("/"));
    let at = root;
    for (const segment of segments.slice(0, -1)) at = directoryNode(at, segment);
    const name = segments.at(-1) ?? entry.name;
    if (entry.isDirectory) {
      const node = directoryNode(at, name);
      node.entry ??= entry;
      continue;
    }
    const key = `${at.path}/${name}`;
    const seen = (duplicates.get(key) ?? 0) + 1;
    duplicates.set(key, seen);
    at.children.push({
      key: seen > 1 ? `${key}#${seen}` : key,
      name,
      path: entry.path,
      isDirectory: false,
      entry,
      children: [],
    });
  }
  return sortNodes(root.children);
}

function directoryNode(parent: ZipTreeNode, name: string): ZipTreeNode {
  const path = `${parent.path}/${name}`;
  const existing = parent.children.find((child) => child.isDirectory && child.name === name);
  if (existing) return existing;
  const node: ZipTreeNode = { key: path, name, path, isDirectory: true, entry: null, children: [] };
  parent.children.push(node);
  return node;
}
