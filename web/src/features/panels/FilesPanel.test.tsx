import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Viewer } from "./FilesPanel";
import { buildZipArchive } from "./zipArchive.test-support";
import { formatBytes } from "./zipArchive";

afterEach(() => vi.restoreAllMocks());

interface ServedFile {
  content: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}

/**
 * Answers the content route with a file record and the raw route with bytes,
 * which is the pair the viewer reads.
 */
function serve(file: ServedFile, raw?: Uint8Array<ArrayBuffer>) {
  const fetch = vi.fn(async (input: string) => {
    if (String(input).includes("/files/raw") && raw) return new Response(raw.slice().buffer);
    return new Response(
      JSON.stringify({ path: "bundle.zip", revision: "r", ...file }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("opens a zip as a folder list with the archive's own size in the bar", async () => {
  const archive = buildZipArchive([
    { name: "notes.txt", data: Buffer.from("hello\n") },
    { name: "src/main.ts", data: Buffer.from("export const main = 1;\n") },
  ]);
  serve({ content: "", binary: true, truncated: false, size: archive.byteLength }, archive);
  render(<Viewer threadId="t" path="bundle.zip" line={null} onBack={() => undefined} />);

  expect(await screen.findByRole("button", { name: /notes\.txt/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /src/ })).toBeInTheDocument();
  // The bar carries the archive's size where a text file would have none.
  expect(screen.getByText(formatBytes(archive.byteLength))).toBeInTheDocument();
  // A zip never reaches the hex view it used to land in.
  expect(screen.queryByLabelText("Bytes")).toBeNull();
  expect(screen.getByLabelText("Save file")).toHaveAttribute("href", expect.stringContaining("/files/raw?"));
});