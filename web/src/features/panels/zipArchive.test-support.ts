import { crc32, deflateRawSync } from "node:zlib";
import { METHOD_DEFLATED, METHOD_STORED } from "./zipArchive";

/** One entry to write into a test archive. */
export interface ZipSpec {
  name?: string;
  /** The raw name bytes, for a name that is not UTF-8. */
  nameBytes?: Buffer;
  data?: Buffer;
  method?: number;
  /** Default true, which sets the general purpose UTF-8 flag. */
  utf8?: boolean;
  encrypted?: boolean;
  /** Overrides the checksum the archive records. */
  crc?: number;
  /** Overrides the size the local header records. */
  uncompressedSize?: number;
  /** Overrides the size the central directory records, for a Zip64 marker. */
  centralUncompressedSize?: number;
  /** Overrides the local header offset the central directory records. */
  centralOffset?: number;
}

export interface ZipOptions {
  comment?: string;
  /** The comment's raw bytes, for a comment that is not text. */
  commentBytes?: Buffer;
  /** Writes a Zip64 end of central directory locator before the record. */
  zip64Locator?: boolean;
  /** Overrides fields of the end of central directory record. */
  eocd?: { entries?: number; directorySize?: number; directoryOffset?: number };
}

/**
 * A zip archive written by hand: each entry's local header and its data, then
 * the central directory, then the end of central directory record. `node:zlib`
 * supplies the deflate stream and the checksum, so these bytes are a real
 * archive rather than a description of one.
 */
export function buildZipArchive(specs: ZipSpec[], options: ZipOptions = {}): Uint8Array<ArrayBuffer> {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const nameBytes = spec.nameBytes ?? Buffer.from(spec.name ?? "", "utf8");
    const data = spec.data ?? Buffer.alloc(0);
    const method = spec.method ?? METHOD_STORED;
    const body = method === METHOD_DEFLATED ? deflateRawSync(data) : data;
    const flags = (spec.utf8 === false ? 0 : 0x800) | (spec.encrypted ? 1 : 0);
    const uncompressed = spec.uncompressedSize ?? data.length;
    const checksum = (spec.crc ?? crc32(data)) >>> 0;

    const here = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(uncompressed, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    offset += local.length + nameBytes.length + body.length;

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(spec.centralUncompressedSize ?? uncompressed, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(spec.centralOffset ?? here, 42);
    centrals.push(central, nameBytes);
  }
  const directory = Buffer.concat(centrals);
  const comment = options.commentBytes ?? Buffer.from(options.comment ?? "", "utf8");
  const count = options.eocd?.entries ?? specs.length;
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(options.eocd?.directorySize ?? directory.length, 12);
  record.writeUInt32LE(options.eocd?.directoryOffset ?? offset, 16);
  record.writeUInt16LE(comment.length, 20);
  const locator = options.zip64Locator ? Buffer.alloc(20) : null;
  locator?.writeUInt32LE(0x07064b50, 0);
  const whole = Buffer.concat([...locals, directory, ...(locator ? [locator] : []), record, comment]);
  const bytes = new Uint8Array(whole.byteLength);
  bytes.set(whole);
  return bytes;
}