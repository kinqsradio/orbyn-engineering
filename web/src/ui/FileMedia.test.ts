import { describe, expect, it } from "vitest";
import { hexRows, mediaKind } from "./FileMedia";

describe("mediaKind", () => {
  it.each([
    ["a/b/Photo.JPG", "image"],
    ["logo.svg", "image"],
    ["clip.webm", "video"],
    ["song.flac", "audio"],
    ["doc.pdf", "pdf"],
    ["Inter.woff2", "font"],
    ["main.rs", null],
    ["png", null],
  ])("reads %s as %s", (path, kind) => expect(mediaKind(path)).toBe(kind));
});

describe("hexRows", () => {
  it("lays out offset, bytes and printable text", () => {
    const rows = hexRows(new Uint8Array([0x41, 0x00, 0xff]), 16);
    expect(rows).toEqual([{ offset: "00000010", hex: "41 00 ff", text: "A.." }]);
  });
  it("breaks every sixteen bytes", () => {
    expect(hexRows(new Uint8Array(17)).map((row) => row.offset)).toEqual(["00000000", "00000010"]);
  });
});
