import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { PreviewTab } from "../../api/types";
import { PageView } from "./BrowserPanel";
import { PageBridge } from "./PageBridge";

class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  close() {}
}

const base = {
  id: "p", thread_id: "t", url: "https://example.com/", title: "Example",
  control: "human", recording: false, viewers: 1, width: 1280, height: 800,
  can_go_back: false, can_go_forward: false, zoom: 1, appearance: "system",
  mobile: false, private: false, profile: null, opened_by: "person", crashed: false,
} satisfies PreviewTab;

let calls: { method: string; path: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, path, body });
    if (path.includes("/uploads")) return new Response(JSON.stringify({ id: "u1" }), { status: 201 });
    if (path.endsWith("/copy")) return new Response(JSON.stringify({ text: "from the page" }), { status: 200 });
    return new Response(null, { status: 204 });
  });
});

it("shows nothing while the page asks for nothing", () => {
  const { container } = render(<PageBridge threadId="t" tab={base} onChanged={() => undefined} />);
  expect(container).toBeEmptyDOMElement();
});

it("uploads the chosen file and answers the page's chooser with it", async () => {
  const changed = vi.fn();
  render(<PageBridge threadId="t" tab={{ ...base, file_chooser: "one" }} onChanged={changed} />);
  expect(screen.getByRole("group", { name: "File chooser" })).toHaveTextContent("The page asks for a file.");
  const file = new File(["hello"], "note.txt", { type: "text/plain" });
  await userEvent.setup().upload(screen.getByLabelText("Files for the page"), file);
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "POST /api/threads/t/previews/p/uploads?name=note.txt",
    "POST /api/threads/t/previews/p/chooser",
  ]);
  expect(calls[1]?.body).toEqual({ files: ["u1"] });
});

it("cancels the chooser with no files", async () => {
  render(<PageBridge threadId="t" tab={{ ...base, file_chooser: "many" }} onChanged={() => undefined} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.body).toEqual({ files: [] });
});

it("lists downloads and offers to save only finished ones", () => {
  const downloads = [
    { id: "a", name: "report.csv", bytes: 2048, state: "done" },
    { id: "b", name: "big.zip", bytes: 10, state: "downloading" },
  ];
  render(<PageBridge threadId="t" tab={{ ...base, downloads }} onChanged={() => undefined} />);
  const list = screen.getByRole("list", { name: "Downloads" });
  expect(list).toHaveTextContent("report.csv");
  expect(list).toHaveTextContent("2 KB");
  expect(list).toHaveTextContent("Downloading...");
  expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(1);
});

it("types pasted text into a held page, and copies its selection out", async () => {
  const written: string[] = [];
  vi.stubGlobal("navigator", { clipboard: { writeText: async (text: string) => void written.push(text) } });
  vi.stubGlobal("ClipboardItem", undefined);
  render(<PageView threadId="t" tab={base} />);
  act(() => FakeSocket.last?.onmessage?.({ data: "AAAA" }));
  const frame = await screen.findByRole("img", { name: /^Page at/ });
  fireEvent.paste(frame, { clipboardData: { getData: () => "pasted" } });
  fireEvent.keyDown(frame, { key: "c", metaKey: true });
  await waitFor(() => expect(written).toEqual(["from the page"]));
  expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "POST /api/threads/t/previews/p/input",
    "POST /api/threads/t/previews/p/copy",
  ]);
  expect(calls[0]?.body).toEqual({ kind: "text", text: "pasted" });
});

it("leaves a watched page's clipboard alone", async () => {
  render(<PageView threadId="t" tab={{ ...base, control: "none" }} />);
  act(() => FakeSocket.last?.onmessage?.({ data: "AAAA" }));
  const frame = await screen.findByRole("img", { name: /^Page at/ });
  fireEvent.paste(frame, { clipboardData: { getData: () => "pasted" } });
  fireEvent.keyDown(frame, { key: "c", ctrlKey: true });
  expect(calls).toHaveLength(0);
});
