import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Viewer } from "./FilesPanel";
import { useUi } from "../../state/ui";
import { buildZipArchive } from "./zipArchive.test-support";
import { formatBytes } from "./zipArchive";
import { buildDocx, buildXlsx, docxParagraph, stubWorker, worksheet } from "./office.test-support";
import { useComposerChips } from "../../state/composer/composerChipStore";
import { FileComments } from "./FileComments";
import { useWorkspace } from "../../state/workspace";

/** The toast the last action raised. */
const lastToast = () => useUi.getState().toasts.at(-1)?.text;

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

afterEach(() => {
  useComposerChips.setState({ chips: {} });
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

it("binds annotation source to cwd and waits for the new checkout's delayed read", async () => {
  useWorkspace.setState({ threads: { t: { id: "t", cwd: "/old" } as never } });
  let finish!: (value: Response) => void;
  const second = new Promise<Response>((done) => { finish = done; });
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    reads += 1;
    return reads === 1 ? new Response(JSON.stringify({ path: "a.txt", revision: "old", content: "OLD_CHECKOUT", size: 12, binary: false, truncated: false })) : second;
  }));
  render(<Viewer threadId="t" path="a.txt" line={null} onBack={() => undefined} />);
  await screen.findByRole("button", { name: "Comment on line 1" });
  act(() => useWorkspace.setState({ threads: { t: { id: "t", cwd: "/new" } as never } }));
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByRole("button", { name: "Comment on line 1" })).not.toBeInTheDocument();
  await act(async () => finish(new Response(JSON.stringify({ path: "a.txt", revision: "new", content: "NEW_CHECKOUT", size: 12, binary: false, truncated: false }))));
  await userEvent.click(await screen.findByRole("button", { name: "Comment on line 1" }));
  await userEvent.type(screen.getByRole("textbox", { name: "File comment" }), "new source only");
  await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
  expect(useComposerChips.getState().chips.t?.[0]).toMatchObject({ excerpt: "NEW_CHECKOUT", sourceCwd: "/new", sourceRevision: "new" });
});

it("says a file is missing from the checkout a moved thread now reads", async () => {
  useWorkspace.setState({ threads: { t: { id: "t", cwd: "/old" } as never } });
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    reads += 1;
    return reads === 1
      ? new Response(JSON.stringify({ path: "notes.txt", revision: "old", content: "OLD_CHECKOUT", size: 12, binary: false, truncated: false }))
      : new Response(JSON.stringify({ code: "not_found", message: "file not found" }), { status: 404 });
  }));
  render(<Viewer threadId="t" path="notes.txt" line={null} onBack={() => undefined} />);
  await screen.findByRole("button", { name: "Comment on line 1" });
  act(() => useWorkspace.setState({ threads: { t: { id: "t", cwd: "/new" } as never } }));
  expect(await screen.findByText("This file isn't in this checkout.")).toBeInTheDocument();
  expect(screen.queryByText("OLD_CHECKOUT")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("captures a reversed source range as one comment and removes the paired chip", async () => {
  render(<FileComments threadId="t" cwd="/repo" path="src/a.ts" revision="r1" text={"one\n<script>\nthree"} revealedLine={null} />);
  await userEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
  fireEvent.click(screen.getByRole("button", { name: "Comment on line 1" }), { shiftKey: true });
  await userEvent.type(screen.getByRole("textbox", { name: "File comment" }), "check this");
  await userEvent.click(screen.getByRole("button", { name: "Add comment" }));
  expect(useComposerChips.getState().chips.t).toEqual([expect.objectContaining({
    kind: "review", path: "src/a.ts", line: 1, endLine: 3, comment: "check this",
    excerpt: "one\n<script>\nthree", sourceRevision: "r1", sourceCwd: "/repo",
  })]);
  expect(screen.getByRole("list", { name: "File comments" })).toHaveTextContent("check this");
  await userEvent.click(screen.getByRole("button", { name: "Remove comment" }));
  expect(useComposerChips.getState().chips.t).toEqual([]);
});

it("scrolls to the revealed line once, not on each selection or keystroke", async () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scroll, configurable: true, writable: true });
  render(<FileComments threadId="t" cwd="/repo" path="a.ts" revision="r1" text={"one\ntwo\nthree"} revealedLine={2} />);
  expect(scroll).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Comment on line 3" }));
  await userEvent.type(screen.getByRole("textbox", { name: "File comment" }), "abc");
  expect(scroll).toHaveBeenCalledTimes(1);
});

it("cancel leaves no chip and another revision never inherits stale annotation positions", async () => {
  const view = render(<FileComments threadId="t" cwd="/repo" path="a.ts" revision="r1" text="one" revealedLine={null} />);
  await userEvent.click(screen.getByRole("button", { name: "Comment on line 1" }));
  await userEvent.type(screen.getByRole("textbox", { name: "File comment" }), "draft");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(useComposerChips.getState().chips.t).toBeUndefined();
  act(() => useComposerChips.getState().add("t", { id: "c", kind: "review", path: "a.ts", line: 1, comment: "old", excerpt: "one", sourceRevision: "r1", sourceCwd: "/repo" }));
  view.rerender(<FileComments key="r2" threadId="t" cwd="/repo" path="a.ts" revision="r2" text="new" revealedLine={null} />);
  expect(screen.queryByRole("list", { name: "File comments" })).not.toBeInTheDocument();
  expect(useComposerChips.getState().chips.t?.[0]).toMatchObject({ comment: "old", excerpt: "one" });
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

it("opens a spreadsheet in the document viewer rather than the hex view", async () => {
  stubWorker();
  const book = buildXlsx([
    { name: "Sheet", xml: worksheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Cell</t></is></c></row>`) },
  ]);
  serve({ content: "", binary: true, truncated: false, size: book.byteLength }, book);
  render(<Viewer threadId="t" path="book.xlsx" line={null} onBack={() => undefined} />);

  expect(await screen.findByRole("tab", { name: "Sheet" })).toBeInTheDocument();
  expect(await screen.findByRole("cell", { name: "Cell" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Bytes")).toBeNull();
});
