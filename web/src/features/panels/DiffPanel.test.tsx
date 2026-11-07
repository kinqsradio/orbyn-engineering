import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { pullsApi } from "../../api/pulls";
import { useComposerChips } from "../thread/composerChipStore";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { DiffPanel, diffCommentRange, nextPageEnd, numberedLines, parsePatch } from "./DiffPanel";
afterEach(() => {
  vi.restoreAllMocks();
  useComposerChips.setState({ chips: {} });
  useUi.getState().setPrefs({ diffLayout: "stacked", diffFilesCollapsed: false });
});
it("shows a historical turn diff without exposing a per-file restore action", async () => {
  const user = userEvent.setup();
  const diff = vi.spyOn(api, "diff").mockResolvedValue([{ path: "notes.txt", status: "modified", additions: 1,
    deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }]);
  vi.spyOn(api, "checkpoints").mockResolvedValue([{ run_id: "r", start: "start", end: "end", created_at: "" }]);
  const changes = vi.spyOn(api, "runChanges").mockResolvedValue({ run_id: "r", paths: ["notes.txt"], truncated: false,
    files: [{ path: "notes.txt", status: "modified", restorable: true }] });
  render(<DiffPanel threadId="t" />);
  await screen.findByRole("button", { name: "Copy path notes.txt" });
  await user.click(screen.getByRole("radio", { name: "Turn" }));
  await waitFor(() => expect(diff).toHaveBeenCalledWith("t", expect.any(AbortSignal), "turn&run=r"));
  await screen.findByRole("button", { name: "Copy path notes.txt" });
  expect(screen.queryByRole("button", { name: /Restore notes.txt/ })).toBeNull();
  expect(changes).not.toHaveBeenCalled();
  expect(screen.getByRole("group", { name: "Patch" })).toHaveTextContent("new");
});

it("switches unified and split, picks a turn and offers restore for it", async () => {
  const user = userEvent.setup();
  const diff = vi.spyOn(api, "diff").mockResolvedValue([{ path: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }]);
  vi.spyOn(api, "checkpoints").mockResolvedValue([
    { run_id: "r1", start: "s1", end: "e1", created_at: "" },
    { run_id: "r2", start: "s2", end: "e2", created_at: "" },
  ]);
  useWorkspace.setState({ threads: { t: { id: "t", active_run: null } as never } });
  vi.spyOn(pullsApi, "linked").mockResolvedValue([]);
  vi.spyOn(api, "branches").mockResolvedValue([]);
  render(<DiffPanel threadId="t" />);
  await screen.findByRole("button", { name: "Copy path a.txt" });
  expect(await screen.findByRole("button", { name: "Create pull request" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore files to before this response" })).toBeNull();
  await user.click(screen.getByRole("radio", { name: "Split" }));
  expect(useUi.getState().diffLayout).toBe("split");
  await user.click(screen.getByRole("radio", { name: "Unified" }));
  expect(useUi.getState().diffLayout).toBe("stacked");
  await user.click(screen.getByRole("radio", { name: "Turn" }));
  const picker = await screen.findByRole("combobox", { name: "Turn" });
  expect(picker).toHaveValue("r2");
  await user.selectOptions(picker, "r1");
  await waitFor(() => expect(diff).toHaveBeenCalledWith("t", expect.any(AbortSignal), "turn&run=r1"));
  expect(screen.getByRole("button", { name: "Restore files to before this response" })).toBeInTheDocument();
});

it("hides Create pull request where the header's Git menu hides, outside a Git repository", async () => {
  vi.spyOn(api, "diff").mockResolvedValue([{ path: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }]);
  vi.spyOn(api, "checkpoints").mockResolvedValue([]);
  useWorkspace.setState({ threads: { t: { id: "t", active_run: null } as never } });
  vi.spyOn(pullsApi, "linked").mockResolvedValue([]);
  vi.spyOn(api, "branches").mockRejectedValue(new Error("not a git repository"));
  render(<DiffPanel threadId="t" />);
  await screen.findByRole("button", { name: "Copy path a.txt" });
  await waitFor(() => expect(api.branches).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
});

it("numbers new lines and adds a review comment chip for one", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "diff").mockResolvedValue([{ path: "notes.txt", status: "modified", additions: 1,
    deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }]);
  render(<DiffPanel threadId="t" />);
  await user.click(await screen.findByRole("button", { name: "Comment on line 1" }));
  await user.type(screen.getByLabelText("Review comment on notes.txt line 1"), "Please rename");
  await user.click(screen.getByRole("button", { name: "Add to message" }));
  expect(useComposerChips.getState().chips.t?.[0]).toMatchObject({
    kind: "review", path: "notes.txt", line: 1, comment: "Please rename", excerpt: "new",
  });
});

const PATCH = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";

it("a diff range comment stays under its last line as long as its chip exists", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "diff").mockResolvedValue([{ path: "notes.txt", status: "modified", additions: 1, deletions: 1, patch: PATCH }]);
  render(<DiffPanel threadId="t" />);
  await user.click(await screen.findByRole("button", { name: "Comment on line 1" }));
  const two = screen.getByRole("button", { name: "Comment on line 2" });
  await user.keyboard("{Shift>}");
  await user.click(two);
  await user.keyboard("{/Shift}");
  await user.type(screen.getByLabelText("Review comment on notes.txt line 1–2"), "Check both");
  await user.click(screen.getByRole("button", { name: "Add to message" }));
  const chip = useComposerChips.getState().chips.t?.[0];
  expect(chip).toMatchObject({ kind: "review", path: "notes.txt", line: 1, endLine: 2, comment: "Check both",
    excerpt: "one\nTWO", sourceRevision: "diff:worktree" });
  const note = screen.getByRole("note", { name: "Review comment notes.txt:1–2" });
  expect(note).toHaveTextContent("Check both");
  // The annotation follows the chip: editing the chip changes it, removing it removes it.
  act(() => useComposerChips.getState().update("t", { ...chip!, comment: "Edited" } as never));
  expect(screen.getByRole("note", { name: "Review comment notes.txt:1–2" })).toHaveTextContent("Edited");
  await user.click(screen.getByRole("button", { name: "Remove comment" }));
  expect(useComposerChips.getState().chips.t ?? []).toHaveLength(0);
  expect(screen.queryByRole("note", { name: /Review comment/ })).toBeNull();
});

it("a diff comment shows only on the diff it was made on", async () => {
  const user = userEvent.setup();
  vi.spyOn(api, "diff").mockResolvedValue([{ path: "notes.txt", status: "modified", additions: 1, deletions: 1, patch: PATCH }]);
  vi.spyOn(api, "commits").mockResolvedValue([{ sha: "a".repeat(40), author: "", date: "", subject: "First" }]);
  useComposerChips.getState().add("t", { id: "c", kind: "review", path: "notes.txt", line: 3, comment: "Here",
    excerpt: "three", sourceRevision: "diff:worktree" });
  render(<DiffPanel threadId="t" />);
  expect(await screen.findByRole("note", { name: "Review comment notes.txt:3" })).toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Commit" }));
  await screen.findByRole("combobox", { name: "Commit" });
  await waitFor(() => expect(screen.queryByRole("note", { name: "Review comment notes.txt:3" })).toBeNull());
});

it("split layout comments on the new side", async () => {
  const user = userEvent.setup();
  useUi.getState().setPrefs({ diffLayout: "split" });
  vi.spyOn(api, "diff").mockResolvedValue([{ path: "notes.txt", status: "modified", additions: 1, deletions: 1, patch: PATCH }]);
  render(<DiffPanel threadId="t" />);
  await user.click(await screen.findByRole("button", { name: "Comment on line 2" }));
  await user.type(screen.getByLabelText("Review comment on notes.txt line 2"), "New side");
  await user.click(screen.getByRole("button", { name: "Add to message" }));
  expect(useComposerChips.getState().chips.t?.[0]).toMatchObject({ line: 2, excerpt: "TWO", comment: "New side" });
  expect(screen.getByRole("note", { name: "Review comment notes.txt:2" })).toBeInTheDocument();
});

it("a diff comment range covers only shown new-side lines and stays within the chip limit", () => {
  const numbered = numberedLines(parsePatch(PATCH));
  expect(diffCommentRange(numbered, 3, 1)).toEqual({ line: 1, endLine: 3, excerpt: "one\nTWO\nthree" });
  expect(diffCommentRange(numbered, 9, 12)).toBeNull();
  const long = numberedLines(parsePatch(`@@ -0,0 +1 @@\n+${"x".repeat(5000)}\n`));
  expect(diffCommentRange(long, 1, 1)).toBeNull();
});

const many = (count: number) => Array.from({ length: count }, (_, at) => ({
  path: `src/file-${String(at).padStart(3, "0")}.ts`, status: "modified", additions: 1, deletions: 1,
  patch: `@@ -1 +1 @@\n-old ${at}\n+needle ${at}\n`,
}));

it("a large diff loads its files a page at a time and find says it covers loaded files only", async () => {
  const user = userEvent.setup();
  // Collapsed rows keep the case light; Find reads patches, not the rendered lines.
  useUi.getState().setPrefs({ diffFilesCollapsed: true });
  vi.spyOn(api, "diff").mockResolvedValue(many(120));
  render(<DiffPanel threadId="t" />);
  await screen.findByRole("button", { name: "Copy path src/file-000.ts" });
  expect(screen.getAllByRole("button", { name: /^Copy path / })).toHaveLength(50);
  // The summary still counts the whole diff.
  expect(screen.getByText("120 files")).toBeInTheDocument();
  await user.click(screen.getByRole("searchbox", { name: "Find in diff" }));
  await user.paste("needle");
  expect(screen.getByText("50 matches")).toBeInTheDocument();
  expect(screen.getByText(/Find covers the 50 of 120 files loaded so far\./)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Load more files (70 left)" }));
  expect(screen.getAllByRole("button", { name: /^Copy path / })).toHaveLength(100);
  expect(screen.getByText("100 matches")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Load more files (20 left)" }));
  expect(screen.getAllByRole("button", { name: /^Copy path / })).toHaveLength(120);
  expect(screen.queryByRole("button", { name: /^Load more files/ })).toBeNull();
  expect(screen.queryByText(/Find covers/)).toBeNull();
}, 20_000);

it("a page also ends at about 4,000 patch lines, never before its first file", () => {
  const big = { patch: "x\n".repeat(3000) };
  expect(nextPageEnd([big, big, big], 0)).toBe(1);
  expect(nextPageEnd([{ patch: "x\n".repeat(9000) }, big], 0)).toBe(1);
  expect(nextPageEnd(many(10), 0)).toBe(10);
  expect(nextPageEnd(many(120), 100)).toBe(120);
});

it("revealing a file past the loaded pages loads it and scrolls to it", async () => {
  const thread = { id: "t", project_id: "p", title: "Big", engine: "codex", model: null, cwd: "/repo", worktree: null,
    skill_profile: null, scratch: false, active_run: null, last_run_state: null, created_at: "", updated_at: "" };
  window.history.replaceState(null, "", "#/threads/t");
  useWorkspace.setState({ threads: { t: thread } as never });
  useUi.getState().setPrefs({ diffFilesCollapsed: true });
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  vi.spyOn(api, "diff").mockResolvedValue(many(120));
  vi.spyOn(api, "resolveThreadPath").mockResolvedValue({ cwd: "/repo", checkout_path: "src/file-110.ts",
    repository_path: "src/file-110.ts" });
  render(<DiffPanel threadId="t" />);
  await screen.findByRole("button", { name: "Copy path src/file-000.ts" });
  expect(screen.queryByRole("button", { name: "Copy path src/file-110.ts" })).toBeNull();
  act(() => useUi.getState().revealDiff("src/file-110.ts", { threadId: "t", cwd: "/repo" }));
  await screen.findByRole("button", { name: "Copy path src/file-110.ts" }, { timeout: 10_000 });
  await waitFor(() => expect(useUi.getState().diffReveal).toBeNull(), { timeout: 10_000 });
  expect(scroll).toHaveBeenCalled();
  useWorkspace.setState({ threads: {} });
}, 20_000);
