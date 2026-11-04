import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { TimelineThread } from "./items";
import { SentFiles, sentPaths } from "./SentFiles";

const thread: Thread = { id: "t", project_id: "p", title: "Thread", engine: "codex", model: null,
  cwd: "/repo", worktree: null, skill_profile: null, scratch: false, active_run: null,
  last_run_state: null, created_at: "", updated_at: "" };

const answer = (body: Blob) => vi.fn(async () => ({ ok: true, status: 200, blob: async () => body }));
const view = (text: string, attachments = [{ id: "a1", name: "notes.txt", mime: "text/plain", size: 5 }]) =>
  render(
    <TimelineThread value="t">
      <SentFiles text={text} attachments={attachments} />
    </TimelineThread>,
  );

beforeEach(() => useWorkspace.setState({ threads: { t: thread } }));
afterEach(() => vi.restoreAllMocks());

it("reads typed mentions as paths, not email addresses", () => {
  expect(sentPaths("look at @src/lib/a.ts and @README.md, then a@b.com and @plain")).toEqual([
    "src/lib/a.ts",
    "README.md",
  ]);
  expect(sentPaths("@src/lib/a.ts again @src/lib/a.ts")).toEqual(["src/lib/a.ts"]);
});

it("shows what the message carried and reveals a typed path", async () => {
  const user = userEvent.setup();
  view("see @src/lib/a.ts");
  expect(screen.getByRole("button", { name: "Open notes.txt" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show src/lib/a.ts" }));
  expect(useUi.getState().fileReveal).toMatchObject({ path: "src/lib/a.ts", line: null, threadId: "t", cwd: "/repo" });
});

it("previews a text attachment from the service", async () => {
  const user = userEvent.setup();
  const fetchMock = answer(new Blob(["hello"], { type: "text/plain" }));
  vi.stubGlobal("fetch", fetchMock);
  view("read it");
  await user.click(screen.getByRole("button", { name: "Open notes.txt" }));
  expect(await screen.findByText("hello")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/attachments/a1/content", expect.objectContaining({ credentials: "same-origin" }));
});

it("opens an image attachment in the lightbox and releases the object URL", async () => {
  const user = userEvent.setup();
  const revoke = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:shot");
  URL.revokeObjectURL = revoke;
  vi.stubGlobal("fetch", answer(new Blob([new Uint8Array([1])], { type: "image/png" })));
  const mounted = view("look", [{ id: "a2", name: "shot.png", mime: "image/png", size: 1 }]);
  await user.click(screen.getByRole("button", { name: "Open shot.png" }));
  expect(await screen.findByLabelText("shot.png")).toBeInTheDocument();
  mounted.unmount();
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:shot"));
});

it("says why a chip could not be opened", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false,
    status: 404,
    json: async () => ({ code: "not_found", message: "That attachment is gone." }),
  })));
  view("read it");
  await user.click(screen.getByRole("button", { name: "Open notes.txt" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("That attachment is gone.");
});
