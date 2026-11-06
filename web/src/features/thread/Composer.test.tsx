import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../../api/client";
import type { Run, SlashCommand, Thread } from "../../api/types";
import { useComposerChips } from "../../state/composerChips";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Composer } from "./Composer";
import { MAX_PROMPT_CHARS, type ReviewChip, type TerminalChip } from "./composerContext";

const thread: Thread = {
  id: "t1",
  project_id: "p",
  title: "Thread",
  engine: "claude",
  model: "opus",
  cwd: "/r",
  worktree: null,
  skill_profile: null,
  scratch: false,
  active_run: null,
  last_run_state: null,
  created_at: "",
  updated_at: "",
};

const run = { id: "r1" } as Run;
const box = () => screen.getByRole("textbox");
const terminalChip: TerminalChip = {
  id: "t-chip",
  kind: "terminal",
  title: "Terminal selection",
  output: "CONTEXT_SENTINEL",
  lineStart: 4,
  lineEnd: 5,
};
const withTerminalChip = () => useComposerChips.setState({ chips: { t1: [terminalChip] } });
const reviewChip: ReviewChip = { id: "review", kind: "review", path: "a.ts", line: 1, endLine: 2,
  comment: "original comment", excerpt: "captured\nsource", sourceRevision: "r", sourceCwd: "/r" };

beforeEach(() => {
  useComposerChips.setState({ chips: {}, reviewDrafts: {} });
  useUi.setState({ drafts: {} });
  useWorkspace.setState({ approvals: { data: [], error: null, loading: false } });
});

function setup(over: Partial<Thread> = {}) {
  vi.spyOn(api, "thread").mockResolvedValue(thread);
  if (!vi.isMockFunction(api.queue)) vi.spyOn(api, "queue").mockResolvedValue([]);
  return render(<Composer thread={{ ...thread, ...over }} engine={null} showContext />);
}

describe("Composer", () => {
  it.each(["send", "queue", "steer"])("keeps an unsaved review detail draft after late %s success", async (mode) => {
    let resolve!: (value: never) => void;
    const pending = new Promise<never>((done) => { resolve = done; });
    const start = vi.spyOn(api, "startRun").mockReturnValue(pending);
    const enqueue = vi.spyOn(api, "enqueue").mockReturnValue(pending);
    const steer = vi.spyOn(api, "steer").mockReturnValue(pending);
    useComposerChips.setState({ chips: { t1: [reviewChip] } });
    useUi.setState({ drafts: { t1: "sent" }, followUpBehavior: mode === "steer" ? "steer" : "queue" });
    setup(mode === "send" ? {} : { active_run: { ...run, state: "running" } as Run });
    await userEvent.type(box(), "{Enter}");
    await waitFor(() => expect(mode === "send" ? start : mode === "queue" ? enqueue : steer).toHaveBeenCalled());
    act(() => useComposerChips.getState().setReviewDraft("t1", { chipId: reviewChip.id, text: "unsaved edit" }));
    await act(async () => resolve((mode === "send" ? run : mode === "steer" ? { state: "delivered" } : {}) as never));
    expect(useComposerChips.getState().chips.t1).toEqual([reviewChip]);
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("unsaved edit");
    start.mockRestore(); enqueue.mockRestore(); steer.mockRestore();
  });
  it.each(["send", "queue", "steer"])("retains a same-ID edited review, new chips/text and another thread after late %s success", async (mode) => {
    let resolve!: (value: never) => void;
    const pending = new Promise<never>((done) => { resolve = done; });
    const start = vi.spyOn(api, "startRun").mockReturnValue(pending);
    const enqueue = vi.spyOn(api, "enqueue").mockReturnValue(pending);
    const steer = vi.spyOn(api, "steer").mockReturnValue(pending);
    useComposerChips.setState({ chips: { t1: [reviewChip, terminalChip], t2: [reviewChip] } });
    useUi.setState({ drafts: { t1: "sent", t2: "other" }, followUpBehavior: mode === "steer" ? "steer" : "queue" });
    setup(mode === "send" ? {} : { active_run: { ...run, state: "running" } as Run });
    await userEvent.type(box(), "{Enter}");
    await waitFor(() => expect(mode === "send" ? start : mode === "queue" ? enqueue : steer).toHaveBeenCalled());
    act(() => {
      useComposerChips.getState().update("t1", { ...reviewChip, comment: "edited during send" });
      useComposerChips.getState().add("t1", { ...terminalChip, id: "new-chip" });
      useUi.getState().setDraft("t1", "new text");
    });
    await act(async () => resolve((mode === "send" ? run : mode === "steer" ? { state: "delivered" } : {}) as never));
    await waitFor(() => expect(useComposerChips.getState().chips.t1?.map((chip) => chip.id)).toEqual(["review", "new-chip"]));
    expect(useComposerChips.getState().chips.t1?.[0]).toMatchObject({ comment: "edited during send" });
    expect(useComposerChips.getState().chips.t2).toEqual([reviewChip]);
    expect(useUi.getState().drafts).toMatchObject({ t1: "new text", t2: "other" });
    start.mockRestore(); enqueue.mockRestore(); steer.mockRestore();
  });

  it.each(["/plan", "/compact", "/goal resume", "/side explain"])("keeps review context when %s cannot carry it", async (command) => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    useComposerChips.setState({ chips: { t1: [reviewChip] } });
    setup();
    await userEvent.type(box(), `${command}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove the review comments");
    expect(useComposerChips.getState().chips.t1).toEqual([reviewChip]);
    expect(box()).toHaveValue(command);
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it("keeps review context after a failed send", async () => {
    const start = vi.spyOn(api, "startRun").mockRejectedValue(new ApiFailure("offline", "offline", 503));
    useComposerChips.setState({ chips: { t1: [reviewChip] } });
    setup();
    await userEvent.type(box(), "keep this{Enter}");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("offline"));
    expect(useComposerChips.getState().chips.t1).toEqual([reviewChip]);
    expect(box()).toHaveValue("keep this");
    start.mockRestore();
  });
  it("sends a terminal selection as labelled rows before the typed draft", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    withTerminalChip();
    setup();
    await userEvent.type(box(), "explain{Enter}");
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(
        "t1",
        "Terminal selection lines 4–5\n```\nCONTEXT_SENTINEL\n```\n\nexplain",
        [],
      ),
    );
    await waitFor(() => expect(useComposerChips.getState().chips.t1).toEqual([]));
    start.mockRestore();
  });

  it.each(["/plan", "/compact", "/goal resume"])('refuses %s while a terminal selection is attached', async (command) => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
    withTerminalChip();
    setup();
    await userEvent.type(box(), `${command}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove the terminal context");
    expect(box()).toHaveValue(command);
    expect(useComposerChips.getState().chips.t1).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    start.mockRestore();
    patch.mockRestore();
  });

  it("refuses a side chat while a terminal selection is attached", async () => {
    withTerminalChip();
    setup();
    await userEvent.type(box(), "/side explain{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Side chats take text only");
    expect(box()).toHaveValue("/side explain");
    expect(useComposerChips.getState().chips.t1).toHaveLength(1);
  });

  it("refuses a terminal selection on an approval reply without deciding it", async () => {
    const decide = vi.spyOn(api, "decideApproval");
    useWorkspace.setState({
      approvals: {
        loading: false,
        error: null,
        data: [{
          id: "approval",
          thread_id: "t1",
          run_id: "r1",
          kind: "tool",
          summary: "Allow?",
          detail: {},
          state: "pending",
          decided_by: null,
          decided_at: null,
          created_at: "",
        }],
      },
    });
    withTerminalChip();
    setup();
    await userEvent.type(box(), "redirect{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("before replying to an approval");
    expect(box()).toHaveValue("redirect");
    expect(useComposerChips.getState().chips.t1).toHaveLength(1);
    expect(decide).not.toHaveBeenCalled();
    decide.mockRestore();
  });

  it("counts the chip block against the message limit", async () => {
    withTerminalChip();
    useUi.setState({ drafts: { t1: "x".repeat(MAX_PROMPT_CHARS) } });
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("characters over the 120,000 limit");
    expect(useComposerChips.getState().chips.t1).toHaveLength(1);
  });

  it("sends on Enter, clears the draft and records the prompt", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    setup();
    await userEvent.type(box(), "hello{Enter}");
    expect(start).toHaveBeenCalledExactlyOnceWith("t1", "hello", []);
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(useThreadLogs.getState().prompts.t1).toEqual([{ runId: "r1", text: "hello" }]);
    start.mockRestore();
  });

  it("adds a line on Shift+Enter", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    setup();
    await userEvent.type(box(), "a{Shift>}{Enter}{/Shift}b");
    expect(box()).toHaveValue("a\nb");
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it("does not send while an IME composition is confirming", () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    useUi.getState().setDraft("t1", "text");
    setup();
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });

  it("keeps drafts per thread and across a remount", () => {
    useUi.getState().setDraft("t1", "one");
    useUi.getState().setDraft("t2", "two");
    const view = setup();
    expect(box()).toHaveValue("one");
    view.unmount();
    setup({ id: "t2" });
    expect(box()).toHaveValue("two");
  });

  it("queues a message during an active run instead of starting one", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    const enqueue = vi.spyOn(api, "enqueue").mockResolvedValue({ id: "q1" } as never);
    setup({ active_run: { ...run, state: "running" } as Run });
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await userEvent.type(box(), "later{Enter}");
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith("t1", "later", []));
    expect(start).not.toHaveBeenCalled();
    await waitFor(() => expect(box()).toHaveValue(""));
    start.mockRestore();
    enqueue.mockRestore();
  });

  it("offers steer, send now and remove on a queued message", async () => {
    const queue = vi.spyOn(api, "queue").mockResolvedValue([
      { id: "q1", thread_id: "t1", prompt: "also check tests", attachment_ids: [], held: false, created_at: "" },
    ]);
    const steer = vi.spyOn(api, "steer").mockResolvedValue({ state: "delivered" });
    const remove = vi.spyOn(api, "removeQueued").mockResolvedValue();
    setup({ active_run: { ...run, state: "running" } as Run });
    await userEvent.click(await screen.findByRole("button", { name: /^Add to the running turn/ }));
    await waitFor(() => expect(steer).toHaveBeenCalledWith("t1", "also check tests"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("q1"));
    queue.mockRestore();
    steer.mockRestore();
    remove.mockRestore();
  });

  it("keeps the draft and explains a failed start", async () => {
    const start = vi
      .spyOn(api, "startRun")
      .mockRejectedValue(new ApiFailure("internal", "Engine missing.", 500));
    setup();
    await userEvent.type(box(), "keep me{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Engine missing.");
    expect(box()).toHaveValue("keep me");
    start.mockRestore();
  });

  it("goes to the trust step when the folder is refused, keeping the draft", async () => {
    const start = vi
      .spyOn(api, "startRun")
      .mockRejectedValue(new ApiFailure("folder_untrusted", "Trust it.", 403));
    setup();
    await userEvent.type(box(), "go{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/trust/p/t1"));
    expect(useUi.getState().drafts.t1).toBe("go");
    start.mockRestore();
  });

  it("completes a $ skill from the keyboard", async () => {
    const mentions = vi.spyOn(api, "mentions").mockResolvedValue({ skills: ["architect"], files: [], threads: [] });
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    setup();
    await userEvent.type(box(), "use $ar");
    expect(await screen.findByRole("listbox", { name: "Suggestions" })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("use $architect ");
    expect(start).not.toHaveBeenCalled();
    mentions.mockRestore();
    start.mockRestore();
  });

  it("completes @ files and / commands", async () => {
    const mentions = vi.spyOn(api, "mentions").mockResolvedValue({ skills: [], files: ["src/main.rs"], threads: [] });
    const commands = vi.spyOn(api, "commands").mockResolvedValue([{ name: "review", description: "Review the diff", source: "engine" } as SlashCommand]);
    setup();
    await userEvent.type(box(), "@ma");
    await screen.findByRole("option", { name: "@src/main.rs" });
    await userEvent.keyboard("{Tab}");
    expect(box()).toHaveValue("@src/main.rs ");
    await userEvent.clear(box());
    await userEvent.type(box(), "/re");
    await screen.findByRole("option", { name: /review/ });
    await userEvent.keyboard("{Enter}");
    expect(box()).toHaveValue("/review ");
    mentions.mockRestore();
    commands.mockRestore();
  });

  it("sends attachments with the run and reports upload failure", async () => {
    const upload = vi
      .spyOn(api, "uploadAttachment")
      .mockResolvedValueOnce({ id: "a1", name: "a.png" } as never)
      .mockRejectedValueOnce(new ApiFailure("too_large", "Too large.", 413));
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    setup();
    const input = screen.getByLabelText("Attach files", { selector: "input" });
    await userEvent.upload(input, new File(["x"], "a.png"));
    expect(await screen.findByText("a.png")).toBeInTheDocument();
    await userEvent.upload(input, new File(["x"], "b.png"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too large.");
    await userEvent.type(box(), "look{Enter}");
    expect(start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove b.png" }));
    await userEvent.type(box(), "{Enter}");
    await waitFor(() => expect(start).toHaveBeenCalledWith("t1", "look", ["a1"]));
    upload.mockRestore();
    start.mockRestore();
  });

  it("holds the branch's place in a Git project until the workspace status names it", () => {
    const project = { id: "p", name: "P", path: "/r", trusted: true, is_git: true, managed: false, scratch: false, created_at: "" };
    useWorkspace.setState({
      projects: { data: [project], error: null, loading: false },
      managed: { data: null, error: null, loading: true },
    });
    const { container } = render(<Composer thread={thread} engine={null} showContext />);
    const context = container.querySelector(".composer-context dl");
    expect(context?.children).toHaveLength(2);
    expect(container.querySelector(".composer-branch-pending")).toHaveAttribute("aria-hidden", "true");
    useWorkspace.setState({ managed: { data: null, error: null, loading: false } });
  });

  it("shows engine and model", () => {
    render(<Composer thread={thread} engine={null} showContext />);
    expect(screen.getByText("opus")).toBeInTheDocument();
  });
});
