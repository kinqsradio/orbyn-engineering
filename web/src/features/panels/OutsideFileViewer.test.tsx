import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { FilesPanel } from "./FilesPanel";
import { OutsideFileViewer, fullPathOf, isFullPath } from "./OutsideFileViewer";

afterEach(() => vi.restoreAllMocks());

const outside = (path: string, content: string, extra: object = {}) =>
  new Response(JSON.stringify({ path, content, size: content.length, binary: false, truncated: false, outside: true, read_only: true, ...extra }));

it("tells full paths from checkout paths on both systems", () => {
  for (const path of ["/etc/hosts", "C:\\Users\\a.txt", "c:/Users/a.txt", "\\\\server\\share\\a"]) expect(isFullPath(path)).toBe(true);
  for (const path of ["src/a.ts", "./a", "../a", "C:a.txt"]) expect(isFullPath(path)).toBe(false);
  expect(fullPathOf("/C:/Users/a.txt")).toBe("C:/Users/a.txt");
  expect(fullPathOf("/etc/hosts")).toBe("/etc/hosts");
});

it("marks the file outside and read-only and offers no edit or save", async () => {
  const fetch = vi.fn(async () => outside("/tmp/notes.txt", "hello"));
  vi.stubGlobal("fetch", fetch);
  render(<OutsideFileViewer threadId="t" path="/tmp/notes.txt" onBack={() => undefined} />);
  expect(await screen.findByText("hello")).toBeInTheDocument();
  expect(screen.getByText(/Outside checkout · Read-only/)).toBeInTheDocument();
  for (const name of ["Edit", "Save", "Save file", "Open in editor", "Add file to message"]) {
    expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name })).not.toBeInTheDocument();
  }
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("/api/threads/t/files/outside?path=%2Ftmp%2Fnotes.txt");
});

it("renders outside HTML only in a frame with no scripts, no same origin and no network", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => outside("/tmp/page.html", "<script>parent.stolen = 1</script><p>page</p>")));
  render(<OutsideFileViewer threadId="t" path="/tmp/page.html" onBack={() => undefined} />);
  const frame = await screen.findByTitle("HTML preview, isolated");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  const doc = frame.getAttribute("srcdoc") ?? "";
  expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<script>"));
  expect(doc).toContain("default-src 'none'");
  await userEvent.click(screen.getByRole("radio", { name: "Source" }));
  expect(screen.getByLabelText("Source of /tmp/page.html")).toHaveTextContent("<script>parent.stolen = 1</script>");
});

it("says a large file is too large instead of showing it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => outside("/tmp/big.log", "", { size: 5 * 1024 * 1024, truncated: true })));
  render(<OutsideFileViewer threadId="t" path="/tmp/big.log" onBack={() => undefined} />);
  expect(await screen.findByText(/too large to show here/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy contents" })).toBeDisabled();
});

it("shows the service's refusal", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "invalid", message: "Orbyn's own data isn't shown here." }), { status: 400 })));
  render(<OutsideFileViewer threadId="t" path="/data/token" onBack={() => undefined} />);
  expect(await screen.findByText(/own data isn't shown here/)).toBeInTheDocument();
});

it("a message link to a full path outside the checkout opens it read-only", async () => {
  const thread = { id: "t", project_id: "p", title: "", engine: "codex", model: null, cwd: "/repo", worktree: null,
    skill_profile: null, scratch: false, active_run: null, last_run_state: null, created_at: "", updated_at: "" };
  window.history.replaceState(null, "", "#/threads/t");
  useWorkspace.setState({ threads: { t: thread } });
  vi.spyOn(api, "resolveThreadPath").mockResolvedValue({ cwd: "/repo", checkout_path: null, repository_path: null });
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    String(url).includes("/files/outside") ? outside("/home/me/notes.md", "# Notes") : new Response("[]")));
  render(<FilesPanel threadId="t" />);
  act(() => useUi.getState().revealFile("/home/me/notes.md", null, { threadId: "t", cwd: "/repo" }));
  expect(await screen.findByText(/Outside checkout · Read-only/)).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Notes" })).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Edit" })).not.toBeInTheDocument();
});
