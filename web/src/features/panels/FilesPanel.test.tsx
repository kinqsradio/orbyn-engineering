import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Viewer } from "./FilesPanel";
import { useUi } from "../../state/ui";
import { buildZipArchive } from "./zipArchive.test-support";
import { formatBytes } from "./zipArchive";
import { buildDocx, docxParagraph, stubWorker } from "./office.test-support";

/** The toast the last action raised. */
const lastToast = () => useUi.getState().toasts.at(-1)?.text;

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

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

it("copies the text the viewer shows", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(async (_text: string) => undefined);
  setClipboard(writeText);
  serve({ content: "alpha\nbeta\n", binary: false, truncated: false, size: 11 });
  render(<Viewer threadId="t" path="notes.txt" line={null} onBack={() => undefined} />);

  const copy = await screen.findByRole("button", { name: "Copy contents" });
  expect(copy).toBeEnabled();
  await user.click(copy);
  expect(writeText).toHaveBeenCalledWith("alpha\nbeta\n");
  await waitFor(() => expect(lastToast()).toBe("Contents copied"));

  // The controls this row already had are still here beside it.
  expect(screen.getByLabelText("Save file")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Source" })).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Edit" })).toBeInTheDocument();
});

it("reports a clipboard failure", async () => {
  const user = userEvent.setup();
  setClipboard(vi.fn(async () => Promise.reject(new Error("Clipboard is blocked."))));
  serve({ content: "alpha\n", binary: false, truncated: false, size: 6 });
  render(<Viewer threadId="t" path="notes.txt" line={null} onBack={() => undefined} />);

  await user.click(await screen.findByRole("button", { name: "Copy contents" }));
  await waitFor(() => expect(lastToast()).toBe("Couldn't copy. Clipboard is blocked."));
});

it("leaves Copy contents disabled for a binary file", async () => {
  serve({ content: "", binary: true, truncated: false, size: 64 }, new Uint8Array([0x00, 0x01, 0x02]));
  render(<Viewer threadId="t" path="image.bin" line={null} onBack={() => undefined} />);
  expect(await screen.findByRole("button", { name: "Copy contents" })).toBeDisabled();
  expect(screen.getByLabelText("Bytes")).toBeInTheDocument();
});

it("leaves Copy contents disabled for a media file", async () => {
  serve({ content: "", binary: true, truncated: false, size: 64 });
  render(<Viewer threadId="t" path="logo.png" line={null} onBack={() => undefined} />);
  expect(await screen.findByRole("button", { name: "Copy contents" })).toBeDisabled();
  expect(screen.getByRole("img")).toBeInTheDocument();
});

it("leaves Copy contents disabled for a truncated file", async () => {
  serve({ content: "", binary: false, truncated: true, size: 12 * 1024 * 1024 });
  render(<Viewer threadId="t" path="huge.log" line={null} onBack={() => undefined} />);
  expect(await screen.findByRole("button", { name: "Copy contents" })).toBeDisabled();
});

it("opens a Word document in the document viewer rather than the hex view", async () => {
  stubWorker();
  const document = buildDocx(
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>${docxParagraph("Hello from Word")}`,
  );
  serve({ content: "", binary: true, truncated: false, size: document.byteLength }, document);
  render(<Viewer threadId="t" path="plan.docx" line={null} onBack={() => undefined} />);

  expect(await screen.findByRole("heading", { name: "Plan" })).toBeInTheDocument();
  expect(screen.getByText("Hello from Word")).toBeInTheDocument();
  expect(screen.queryByLabelText("Bytes")).toBeNull();
  // The bar carries the document's size where a text file would have none.
  expect(screen.getByText(formatBytes(document.byteLength))).toBeInTheDocument();
});
