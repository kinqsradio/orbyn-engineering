import { crc32 as checksum } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { buildZipArchive as buildZip } from "./zipArchive.test-support";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_BYTES,
  METHOD_DEFLATED,
  METHOD_STORED,
  ZipError,
  buildZipTree,
  crc32,
  decodeCp437,
  decodeEntryName,
  decodeEntryText,
  entryDataRange,
  findEndOfCentralDirectory,
  formatBytes,
  looksBinary,
  readEntryBytes,
  readZipArchive,
  sanitizeEntryName,
  storedEntryBytes,
  type ZipEntry,
  type ZipReadResult,
} from "./zipArchive";

/** The entries of an archive the reader accepted. */
function read(bytes: Uint8Array<ArrayBuffer>): ZipEntry[] {
  const result = readZipArchive(bytes);
  if (!result.ok) throw new Error(`Expected an archive, got ${result.code}: ${result.message}`);
  return result.entries;
}

/** The refusal of an archive the reader rejected. */
function refusal(bytes: Uint8Array<ArrayBuffer>): Extract<ZipReadResult, { ok: false }> {
  const result = readZipArchive(bytes);
  if (result.ok) throw new Error("Expected this archive to be refused.");
  return result;
}

/** The error one entry read raised. */
async function entryError(promise: Promise<unknown>): Promise<ZipError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZipError) return error;
    throw error;
  }
  throw new Error("Expected this entry to be refused.");
}

const entryNamed = (entries: ZipEntry[], path: string): ZipEntry => {
  const found = entries.find((entry) => entry.path === path);
  if (!found) throw new Error(`No entry named ${path}`);
  return found;
};

describe("readZipArchive", () => {
  it("lists a stored and a deflated entry with their sizes, methods and offsets", () => {
    const notes = Buffer.from("a longer body, deflated ".repeat(20));
    const bytes = buildZip([
      { name: "hello.txt", data: Buffer.from("hello world"), method: METHOD_STORED },
      { name: "notes.txt", data: notes, method: METHOD_DEFLATED },
    ]);
    const entries = read(bytes);
    expect(entries.map((entry) => entry.path)).toEqual(["hello.txt", "notes.txt"]);
    expect(entries[0]).toMatchObject({
      name: "hello.txt",
      isDirectory: false,
      method: METHOD_STORED,
      compressedSize: 11,
      uncompressedSize: 11,
      encrypted: false,
      localHeaderOffset: 0,
    });
    expect(entries[0]?.crc32).toBe(checksum(Buffer.from("hello world")) >>> 0);
    expect(entries[1]).toMatchObject({ method: METHOD_DEFLATED, uncompressedSize: notes.length });
    expect(entries[1]?.compressedSize).toBeLessThan(notes.length);
    // The second local header is where the first entry's bytes end.
    expect(entries[1]?.localHeaderOffset).toBe(30 + "hello.txt".length + 11);
  });

  it("keeps a nested path and a directory entry apart", () => {
    const bytes = buildZip([
      { name: "src/", data: Buffer.alloc(0) },
      { name: "src/app/main.ts", data: Buffer.from("export const main = 1;\n") },
      { name: "README.md", data: Buffer.from("# hi\n") },
    ]);
    const entries = read(bytes);
    expect(entries.map((entry) => [entry.path, entry.isDirectory])).toEqual([
      ["src", true],
      ["src/app/main.ts", false],
      ["README.md", false],
    ]);
    expect(entryNamed(entries, "src/app/main.ts").name).toBe("main.ts");
  });

  it("reads a name written as UTF-8 although the flag is unset", () => {
    const bytes = buildZip([{ name: "café.txt", utf8: false, data: Buffer.from("x") }]);
    expect(read(bytes)[0]?.path).toBe("café.txt");
  });

  it("falls back to code page 437 when an unflagged name is not UTF-8", () => {
    const bytes = buildZip([{ nameBytes: Buffer.from([0x81, 0x8e, 0x2e, 0x74, 0x78, 0x74]), utf8: false }]);
    expect(read(bytes)[0]?.path).toBe("üÄ.txt");
  });

  it("reads a name the entry marks as UTF-8", () => {
    const bytes = buildZip([{ name: "日本語/メモ.txt", data: Buffer.from("x") }]);
    expect(read(bytes)[0]?.path).toBe("日本語/メモ.txt");
  });

  it("cleans a nonsense name instead of trusting it", () => {
    const bytes = buildZip([
      { name: "…/../\u0007evil\u202e.txt", data: Buffer.from("x") },
      { name: "/leading/slash.txt", data: Buffer.from("x") },
    ]);
    expect(read(bytes).map((entry) => entry.path)).toEqual(["…/evil.txt", "leading/slash.txt"]);
  });

  it("names an entry that has no name left", () => {
    const bytes = buildZip([{ name: "..", data: Buffer.from("x") }]);
    expect(read(bytes)[0]?.path).toBe("(unnamed)");
  });

  it("refuses a Zip64 archive at its locator", () => {
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("x") }], { zip64Locator: true });
    expect(refusal(bytes)).toMatchObject({ code: "zip64" });
    expect(refusal(bytes).message).toBe("This archive is Zip64, so it is too large for this viewer.");
  });

  it("refuses a Zip64 entry size rather than guessing", () => {
    const bytes = buildZip([{ name: "big.bin", data: Buffer.from("x"), centralUncompressedSize: 0xffffffff }]);
    expect(refusal(bytes).code).toBe("zip64");
  });

  it("refuses a Zip64 central directory offset", () => {
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("x") }], { eocd: { directoryOffset: 0xffffffff } });
    expect(refusal(bytes).code).toBe("zip64");
  });

  it("refuses an archive past the 50 MB cap", () => {
    const result = refusal(new Uint8Array(MAX_ARCHIVE_BYTES + 1024));
    expect(result.code).toBe("zip_too_large");
    expect(result.message).toContain("at most 50 MB");
  });

  it("refuses an archive past the entry cap", () => {
    const specs = Array.from({ length: 2001 }, (_, at) => ({ name: `file-${at}.txt`, data: Buffer.from("x") }));
    const result = refusal(buildZip(specs));
    expect(result.code).toBe("zip_too_many_entries");
    expect(result.message).toContain("at most 2000");
  });

  it("lists exactly the entry cap", () => {
    const specs = Array.from({ length: 2000 }, (_, at) => ({ name: `file-${at}.txt`, data: Buffer.from("x") }));
    expect(read(buildZip(specs))).toHaveLength(2000);
  });

  it("refuses a file with no end of central directory", () => {
    const whole = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const result = refusal(whole.subarray(0, whole.length - 22));
    expect(result.code).toBe("zip_unreadable");
    expect(result.message).toContain("central directory");
  });

  it("refuses a damaged central directory", () => {
    const whole = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const damaged = whole.slice();
    const directoryAt = findEndOfCentralDirectory(damaged) + 16;
    const view = new DataView(damaged.buffer, damaged.byteOffset, damaged.byteLength);
    damaged[view.getUint32(directoryAt, true)] = 0;
    expect(refusal(damaged).code).toBe("zip_unreadable");
  });

  it("refuses an empty buffer as cleanly as any other", () => {
    expect(refusal(new Uint8Array(0)).code).toBe("zip_unreadable");
    expect(readZipArchive(new Uint8Array([1, 2, 3])).ok).toBe(false);
  });

  it("reads past an end-of-central-directory-shaped record inside a comment", () => {
    const entries = [
      { name: "one.txt", data: Buffer.from("1") },
      { name: "two.txt", data: Buffer.from("2") },
    ];
    // The offset of the real central directory, so a record that trusted this
    // fake one would read exactly one entry out of it.
    const directoryAt = Buffer.from(buildZip(entries)).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(directoryAt).toBeGreaterThan(0);
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(1, 10);
    fake.writeUInt32LE(directoryAt, 16);
    // The comment runs on past the fake record, so the fake's own comment
    // length does not reach the end of the file and the real record does.
    const bytes = buildZip(entries, {
      commentBytes: Buffer.concat([fake, Buffer.from("and the comment carries on")]),
    });
    expect(read(bytes).map((entry) => entry.path)).toEqual(["one.txt", "two.txt"]);
  });

  it("refuses a file whose record does not end at the end of the file", () => {
    const whole = buildZip([{ name: "a.txt", data: Buffer.from("x") }]);
    const padded = new Uint8Array(whole.length + 4);
    padded.set(whole);
    const result = refusal(padded);
    expect(result.code).toBe("zip_unreadable");
    expect(result.message).toContain("central directory");
    expect(findEndOfCentralDirectory(padded)).toBe(-1);
  });

  it("finds the record behind a long comment", () => {
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("x") }], { comment: "x".repeat(60_000) });
    expect(findEndOfCentralDirectory(bytes)).toBe(bytes.length - 22 - 60_000);
    expect(read(bytes)).toHaveLength(1);
  });
});

describe("readEntryBytes", () => {
  it("reads a stored entry exactly", async () => {
    const data = Buffer.from("stored bytes\n");
    const bytes = buildZip([{ name: "a.txt", data, method: METHOD_STORED }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect(new Uint8Array(await readEntryBytes(bytes, entry))).toEqual(new Uint8Array(data));
  });

  it("decompresses a deflated entry exactly", async () => {
    const data = Buffer.from("deflated bytes, long enough to compress well\n".repeat(40));
    const bytes = buildZip([{ name: "a.txt", data, method: METHOD_DEFLATED }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect(new Uint8Array(await readEntryBytes(bytes, entry))).toEqual(new Uint8Array(data));
  });

  it("points an entry's data past its local name and extra field", () => {
    const bytes = buildZip([{ name: "a-later-entry.txt", data: Buffer.from("xy") }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect(entryDataRange(bytes, entry)).toEqual({ start: 30 + "a-later-entry.txt".length, length: 2 });
    expect([...storedEntryBytes(bytes, entry)]).toEqual([0x78, 0x79]);
  });

  it("refuses an encrypted entry", async () => {
    const bytes = buildZip([{ name: "secret.txt", data: Buffer.from("x"), encrypted: true }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect(entry.encrypted).toBe(true);
    const error = await entryError(readEntryBytes(bytes, entry));
    expect(error.code).toBe("entry_encrypted");
    expect(error.message).toContain("encrypted");
  });

  it("refuses an entry past the 2 MiB read cap", async () => {
    const entry: ZipEntry = {
      name: "big.bin",
      path: "big.bin",
      isDirectory: false,
      method: METHOD_STORED,
      flags: 0,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: MAX_ENTRY_BYTES + 1,
      localHeaderOffset: 0,
      encrypted: false,
    };
    const error = await entryError(readEntryBytes(new Uint8Array(30), entry));
    expect(error.code).toBe("entry_too_large");
    expect(error.message).toContain("at most 2 MB");
  });

  it("stops an entry that expands past the cap while it streams", async () => {
    const data = Buffer.from("0123456789".repeat(200));
    const bytes = buildZip([{ name: "bomb.txt", data, method: METHOD_DEFLATED, uncompressedSize: 10 }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    const error = await entryError(readEntryBytes(bytes, entry, 64));
    expect(error.code).toBe("entry_too_large");
  });

  it("refuses a directory", async () => {
    const bytes = buildZip([{ name: "src/", data: Buffer.alloc(0) }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect((await entryError(readEntryBytes(bytes, entry))).code).toBe("entry_is_directory");
  });

  it("refuses a compression method it cannot read", async () => {
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("x"), method: 12 }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    const error = await entryError(readEntryBytes(bytes, entry));
    expect(error.code).toBe("entry_unsupported");
    expect(error.message).toContain("method 12");
  });

  it("refuses bytes that do not match the directory's checksum", async () => {
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("hello"), crc: 0xdeadbeef }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect((await entryError(readEntryBytes(bytes, entry))).message).toContain("checksum");
  });

  it("refuses bytes that do not match the directory's size", async () => {
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("hello"), uncompressedSize: 3 }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect((await entryError(readEntryBytes(bytes, entry))).code).toBe("entry_corrupt");
  });

  it("says plainly when the platform cannot decompress", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("hello there"), method: METHOD_DEFLATED }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    const error = await entryError(readEntryBytes(bytes, entry));
    expect(error.code).toBe("no_decompression");
    expect(error.message).toContain("can't decompress");
  });

  it("still reads a stored entry without a decompressor", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    const bytes = buildZip([{ name: "a.txt", data: Buffer.from("plain"), method: METHOD_STORED }]);
    const entry = read(bytes)[0];
    if (!entry) throw new Error("no entry");
    expect(decodeEntryText(await readEntryBytes(bytes, entry))).toBe("plain");
  });
});

describe("buildZipTree", () => {
  it("puts directories first and nests entries by their path", () => {
    const entries = read(
      buildZip([
        { name: "b.txt", data: Buffer.from("x") },
        { name: "src/z.txt", data: Buffer.from("x") },
        { name: "src/a.txt", data: Buffer.from("x") },
        { name: "a.txt", data: Buffer.from("x") },
      ]),
    );
    const tree = buildZipTree(entries);
    expect(tree.map((node) => [node.name, node.isDirectory])).toEqual([
      ["src", true],
      ["a.txt", false],
      ["b.txt", false],
    ]);
    expect(tree[0]?.children.map((node) => node.name)).toEqual(["a.txt", "z.txt"]);
    expect(tree[0]?.path).toBe("/src");
    expect(tree[0]?.children[0]?.path).toBe("src/a.txt");
  });

  it("makes a folder the archive has no entry for", () => {
    const entries = read(buildZip([{ name: "deep/nest/leaf.txt", data: Buffer.from("x") }]));
    const tree = buildZipTree(entries);
    const deep = tree[0];
    expect(deep?.entry).toBeNull();
    expect(deep?.children[0]?.name).toBe("nest");
    expect(deep?.children[0]?.children[0]?.entry?.path).toBe("deep/nest/leaf.txt");
  });

  it("keeps an explicit directory entry when the archive has one", () => {
    const entries = read(
      buildZip([
        { name: "src/", data: Buffer.alloc(0) },
        { name: "src/a.txt", data: Buffer.from("x") },
      ]),
    );
    const tree = buildZipTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.entry?.isDirectory).toBe(true);
    expect(tree[0]?.children).toHaveLength(1);
  });

  it("keeps two entries that share a name apart", () => {
    const entries = read(
      buildZip([
        { name: "same.txt", data: Buffer.from("one") },
        { name: "same.txt", data: Buffer.from("two") },
      ]),
    );
    const tree = buildZipTree(entries);
    expect(tree.map((node) => node.key)).toEqual(["/same.txt", "/same.txt#2"]);
  });
});

describe("names and sizes", () => {
  it("strips control characters, dots and empty segments from a name", () => {
    expect(sanitizeEntryName("dir\u0000name/file\u001f.txt")).toBe("dirname/file.txt");
    expect(sanitizeEntryName("./a/./b/../c.txt")).toBe("a/b/c.txt");
    expect(sanitizeEntryName("/")).toBe("");
    expect(sanitizeEntryName("a//b.txt")).toBe("a/b.txt");
  });

  it("folds an over-deep name instead of nesting without limit", () => {
    const name = Array.from({ length: 40 }, (_, at) => `s${at}`).join("/");
    const entries = read(buildZip([{ name, data: Buffer.from("x") }]));
    let nodes = buildZipTree(entries);
    let depth = 0;
    while (nodes.length > 0) {
      depth += 1;
      nodes = nodes[0]?.children ?? [];
    }
    expect(depth).toBe(32);
  });

  it("decodes legacy names through code page 437", () => {
    expect(decodeCp437(new Uint8Array([0x41, 0x81, 0x8e]))).toBe("AüÄ");
    expect(new Uint8Array([0x41])).toHaveLength(1);
  });

  it("honours the UTF-8 flag even when the legacy reading would differ", () => {
    expect(decodeEntryName(new Uint8Array([0xc3, 0xa9]), true)).toBe("é");
    expect(decodeEntryName(new Uint8Array([0xc3, 0xa9]), false)).toBe("é");
  });

  it("calls bytes with a NUL binary", () => {
    expect(looksBinary(new Uint8Array([0x68, 0x69]))).toBe(false);
    expect(looksBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
    expect(looksBinary(new Uint8Array(9000))).toBe(true);
  });

  it("writes a size the way a person reads it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(MAX_ARCHIVE_BYTES)).toBe("50 MB");
    expect(formatBytes(MAX_ENTRY_BYTES + 1)).toBe("2.0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("checks a checksum the way the zip directory does", () => {
    expect(crc32(new TextEncoder().encode("hello world"))).toBe(checksum(Buffer.from("hello world")) >>> 0);
  });
});
