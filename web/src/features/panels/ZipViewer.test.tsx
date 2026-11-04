import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ZipViewer } from "./ZipViewer";
import { buildZipArchive } from "./zipArchive.test-support";
import { METHOD_DEFLATED, METHOD_STORED } from "./zipArchive";

afterEach(() => vi.restoreAllMocks());

/** Serves one archive over the raw route, whatever the address asks for. */
function stubArchive(bytes: Uint8Array<ArrayBuffer>, status = 200) {
  const fetch = vi.fn(async (_input: string) => new Response(bytes.slice().buffer, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const rows = () => within(screen.getByRole("list")).getAllByRole("button");

/** What each row shows: its name, and the size a file row prints. */
const shown = () =>
  rows().map((row) => ({
    name: row.querySelector(".zip-name")?.textContent,
    size: row.querySelector(".zip-size")?.textContent,
  }));

it("lists directories ahead of files and nests them by path", async () => {
  const user = userEvent.setup();
  stubArchive(
    buildZipArchive([
      { name: "README.md", data: Buffer.from("# title\n") },
      { name: "src/app/main.ts", data: Buffer.from("export const main = 1;\n") },
      { name: "src/notes.txt", data: Buffer.from("note\n") },
      { name: "assets/logo.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]),
  );
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  await screen.findByRole("button", { name: /src/ });
  expect(shown().map((row) => row.name)).toEqual(["assets", "src", "README.md"]);

  await user.click(screen.getByRole("button", { name: /src/ }));
  expect(shown().map((row) => row.name)).toEqual(["assets", "src", "app", "notes.txt", "README.md"]);
  expect(shown().map((row) => row.name)).not.toContain("main.ts");

  await user.click(screen.getByRole("button", { name: /app/ }));
  expect(shown().map((row) => row.name)).toContain("main.ts");

  // The same folder closes again.
  await user.click(screen.getByRole("button", { name: /app/ }));
  expect(shown().map((row) => row.name)).not.toContain("main.ts");
});

it("shows each file's size in a human form", async () => {
  stubArchive(
    buildZipArchive([
      { name: "small.txt", data: Buffer.from("x".repeat(512)) },
      { name: "medium.txt", data: Buffer.from("x".repeat(1536)) },
      { name: "big.txt", data: Buffer.from("x".repeat(2 * 1024 * 1024)) },
    ]),
  );
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  await screen.findByRole("button", { name: /small/ });
  expect(Object.fromEntries(shown().map((row) => [row.name, row.size]))).toEqual({
    "small.txt": "512 B",
    "medium.txt": "1.5 KB",
    "big.txt": "2 MB",
  });
});

it("opens a text entry in a source view", async () => {
  const user = userEvent.setup();
  stubArchive(
    buildZipArchive([
      { name: "notes.txt", data: Buffer.from("first line\nsecond line\n"), method: METHOD_DEFLATED },
    ]),
  );
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  await user.click(await screen.findByRole("button", { name: /notes\.txt/ }));
  expect(await screen.findByLabelText("Contents of notes.txt")).toHaveTextContent("first line second line");
});

it("renders a markdown entry with the existing preview", async () => {
  const user = userEvent.setup();
  stubArchive(buildZipArchive([{ name: "docs/readme.md", data: Buffer.from("# Heading\n") }]));
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  await user.click(await screen.findByRole("button", { name: /docs/ }));
  await user.click(await screen.findByRole("button", { name: /readme\.md/ }));
  expect(await screen.findByRole("radio", { name: "Preview" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Heading" })).toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Source" }));
  expect(screen.getByLabelText("Contents of docs/readme.md")).toHaveTextContent("# Heading");
});

it("offers a binary entry for saving instead of showing it", async () => {
  const user = userEvent.setup();
  stubArchive(buildZipArchive([{ name: "logo.png", data: Buffer.from([0x89, 0x50, 0x00, 0x47]), method: METHOD_STORED }]));
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  await user.click(await screen.findByRole("button", { name: /logo\.png/ }));
  expect(await screen.findByRole("button", { name: "Save entry" })).toBeInTheDocument();
  expect(screen.getByText("This entry is not text, so it has no preview here. Save it to read it.")).toBeInTheDocument();
  expect(screen.queryByLabelText(/Contents of logo\.png/)).toBeNull();
});

it("refuses an encrypted entry and marks it in the list", async () => {
  const user = userEvent.setup();
  stubArchive(buildZipArchive([{ name: "secret.txt", data: Buffer.from("hush"), encrypted: true }]));
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  const row = await screen.findByRole("button", { name: /secret\.txt/ });
  expect(row).toHaveTextContent("encrypted");
  await user.click(row);
  expect(await screen.findByRole("alert")).toHaveTextContent("This entry is encrypted, so the viewer can't read it.");
  expect(screen.queryByRole("button", { name: "Save entry" })).toBeNull();
});

it("refuses an entry past the read cap instead of reading it", async () => {
  const user = userEvent.setup();
  stubArchive(buildZipArchive([{ name: "huge.txt", data: Buffer.from("x".repeat(2 * 1024 * 1024 + 1)) }]));
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  await user.click(await screen.findByRole("button", { name: /huge\.txt/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("the viewer reads at most 2 MB of an entry");
});

it("refuses an archive that is not a zip in the panel's error state", async () => {
  stubArchive(new Uint8Array(Buffer.from("not a zip at all")));
  render(<ZipViewer threadId="t" path="notes.zip" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read this archive");
  expect(screen.queryByRole("list")).toBeNull();
});

it("offers the file's own bytes when it can't be read as an archive", async () => {
  const user = userEvent.setup();
  stubArchive(new Uint8Array(Buffer.from("not a zip at all")));
  render(<ZipViewer threadId="t" path="notes.zip" size={16} />);
  await screen.findByRole("alert");
  await user.click(screen.getByRole("button", { name: "Show the file's bytes" }));
  expect(await screen.findByLabelText("Bytes")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to the reader" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read this archive");
});

it("refuses an archive past the 50 MB cap with the reason", async () => {
  stubArchive(new Uint8Array(50 * 1024 * 1024 + 1));
  render(<ZipViewer threadId="t" path="huge.zip" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("the viewer opens at most 50 MB");
});

it("reports a raw route failure", async () => {
  stubArchive(new Uint8Array(0), 500);
  render(<ZipViewer threadId="t" path="bundle.zip" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("The service answered 500");
});

it("reads the archive through the raw route, which carries the token", async () => {
  const fetch = stubArchive(buildZipArchive([{ name: "a.txt", data: Buffer.from("x") }]));
  sessionStorage.setItem("orbyn.token", "secret");
  render(<ZipViewer threadId="t" path="a folder/bundle.zip" />);
  await screen.findByRole("button", { name: /a\.txt/ });
  const [called] = fetch.mock.calls[0] ?? [];
  const url = new URL(String(called), "http://localhost");
  expect(url.pathname).toBe("/api/threads/t/files/raw");
  expect(url.searchParams.get("path")).toBe("a folder/bundle.zip");
  expect(url.searchParams.get("token")).toBe("secret");
  sessionStorage.clear();
});