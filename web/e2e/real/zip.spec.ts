import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { send, settled, startProject, threadIdOf, type Service } from "./service";

/**
 * A real archive through the real service: the reader parses a zip this test
 * builds, and `DecompressionStream` inflates its entries in a real browser. The
 * unit tests build their archives with the same platform pieces under Node, which
 * is why this one exists.
 */

let service: Service;
let projectId = "";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with stored and deflated entries, written by hand so no dependency is added. */
function buildZip(entries: { name: string; body: string; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.body, "utf8");
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test.beforeAll(async () => {
  ({ service, projectId } = await startProject({ scenes: true }));
});
test.afterAll(() => service.stop());

test("a zip lists its folders and reads a deflated entry in a real browser", async ({ page }) => {
  writeFileSync(
    join(service.repo, "bundle.zip"),
    buildZip([
      { name: "hello.txt", body: "hello from the archive\n", deflate: true },
      { name: "stored.txt", body: "stored, not deflated\n", deflate: false },
      { name: "docs/inner.txt", body: "nested entry\n", deflate: true },
    ]),
  );
  // A thread with one turn, so the thread toolbar (and its Files panel) exists.
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto(`${service.page}#/new/${projectId}`);
  await send(page, "[scene:timeline] hello");
  await expect(page).toHaveURL(/#\/threads\//);
  await settled(service, threadIdOf(page));

  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search" }).fill("bundle.zip");
  await palette.getByRole("button", { name: /bundle\.zip/ }).first().click();

  // The central directory is parsed: a folder, two files, and the sizes are real.
  await expect(page.getByRole("button", { name: /^docs/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /hello\.txt/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /stored\.txt/ })).toBeVisible();

  // A deflated entry is inflated by the browser's own DecompressionStream.
  await page.getByRole("button", { name: /hello\.txt/ }).click();
  await expect(page.getByLabel("Contents of hello.txt")).toContainText("hello from the archive");
  await page.getByRole("button", { name: /stored\.txt/ }).click();
  await expect(page.getByLabel("Contents of stored.txt")).toContainText("stored, not deflated");

  // A nested entry sits behind its folder.
  await page.getByRole("button", { name: /^docs/ }).click();
  await page.getByRole("button", { name: /inner\.txt/ }).click();
  await expect(page.getByLabel("Contents of docs/inner.txt")).toContainText("nested entry");

  // The archive is a file in the panel like any other, and it saves.
  await expect(page.getByRole("link", { name: "Save file" })).toHaveAttribute("href", /download=true/);
});