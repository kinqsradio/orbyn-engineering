import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../../api/client";
import type { Run, SlashCommand, Thread } from "../../api/types";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { Composer } from "./Composer";
import { useWorkspace } from "../../state/workspace";
import { terminalContextPrompt, type TerminalExcerpt } from "./terminalContext";

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
const terminalExcerpt: TerminalExcerpt = { id: "excerpt", terminalId: "main", terminalLabel: "Terminal", lineStart: 1, lineEnd: 2, text: "/plan\n<script>plain text</script>" };

function setup(over: Partial<Thread> = {}) {
  vi.spyOn(api, "thread").mockResolvedValue(thread);
  if (!vi.isMockFunction(api.queue)) vi.spyOn(api, "queue").mockResolvedValue([]);
  return render(<Composer thread={{ ...thread, ...over }} engine={null} showContext />);
}

describe("Composer", () => {
  it("previews and removes explicit context without putting output in the textarea", async () => {
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    expect(box()).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: /Terminal excerpt.*Show details/ }));
    expect(screen.getByLabelText("Captured terminal output")).toHaveTextContent("/plan");
    expect(document.querySelector("script")).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Captured terminal output")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Terminal excerpt.*Show details/ })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: /Terminal excerpt.*Show details/ }));
    await userEvent.click(screen.getByRole("button", { name: /Remove terminal excerpt/ }));
    expect(useUi.getState().terminalContexts.t1).toBeUndefined();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });

  it("sends context alone as data rather than executing its slash command", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "{Enter}");
    await waitFor(() => expect(start).toHaveBeenCalledWith("t1", terminalContextPrompt("", [terminalExcerpt]), []));
    await waitFor(() => expect(useUi.getState().terminalContexts.t1).toBeUndefined());
    start.mockRestore();
  });

  it.each(["queue", "steer"] as const)("carries the same excerpt through %s", async (behavior) => {
    const enqueue = vi.spyOn(api, "enqueue").mockResolvedValue({ id: "q1", thread_id: "t1", prompt: "", attachment_ids: [], held: false, created_at: "" });
    const steer = vi.spyOn(api, "steer").mockResolvedValue({ state: "delivered" });
    useUi.setState({ followUpBehavior: behavior === "queue" ? "queue" : "steer" });
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup({ active_run: { ...run, state: "running" } as Run });
    await userEvent.type(box(), "explain{Enter}");
    const prompt = terminalContextPrompt("explain", [terminalExcerpt]);
    await waitFor(() => behavior === "queue"
      ? expect(enqueue).toHaveBeenCalledWith("t1", prompt, [])
      : expect(steer).toHaveBeenCalledWith("t1", prompt));
    await waitFor(() => expect(useUi.getState().terminalContexts.t1).toBeUndefined());
    enqueue.mockRestore(); steer.mockRestore();
  });

  it("retains context on failed send", async () => {
    const start = vi.spyOn(api, "startRun").mockRejectedValue(new Error("offline"));
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "keep{Enter}");
    await screen.findByRole("alert");
    expect(box()).toHaveValue("keep");
    expect(useUi.getState().terminalContexts.t1).toEqual([terminalExcerpt]);
    start.mockRestore();
  });

  it("acknowledges submitted excerpts without clearing newer text or chips", async () => {
    let finish!: (value: Run) => void;
    const start = vi.spyOn(api, "startRun").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "sent{Enter}");
    await waitFor(() => expect(start).toHaveBeenCalled());
    await userEvent.type(box(), " newer");
    act(() => { useUi.getState().addTerminalContext("t1", { ...terminalExcerpt, id: "new" }); });
    await act(async () => { finish(run); });
    expect(box()).toHaveValue("sent newer");
    expect(useUi.getState().terminalContexts.t1?.map((item) => item.id)).toEqual(["new"]);
    start.mockRestore();
  });

  it("retains context and refuses a side-chat command", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "/side explain{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Side chats take text only");
    expect(start).not.toHaveBeenCalled();
    expect(useUi.getState().terminalContexts.t1).toEqual([terminalExcerpt]);
    start.mockRestore();
  });
  it("refuses a typed local command while retaining the draft and context", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "/plan{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove the terminal context before using /plan");
    expect(box()).toHaveValue("/plan");
    expect(useUi.getState().terminalContexts.t1).toEqual([terminalExcerpt]);
    expect(start).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    start.mockRestore(); patch.mockRestore();
  });
  it.each(["/goal clear", "/goal pause", "/goal resume", "/goal new goal", "/compact"])("retains context instead of altering %s", async (command) => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), `${command}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove the terminal context before using");
    expect(box()).toHaveValue(command);
    expect(useUi.getState().terminalContexts.t1).toEqual([terminalExcerpt]);
    expect(start).not.toHaveBeenCalled();
    start.mockRestore();
  });
  it("refuses context on an approval reply without deciding the approval", async () => {
    const decide = vi.spyOn(api, "decideApproval");
    useWorkspace.setState({ approvals: { loading: false, error: null, data: [{ id: "approval", thread_id: "t1", run_id: "r1", kind: "tool", summary: "Allow?", detail: {}, state: "pending", decided_by: null, decided_at: null, created_at: "" }] } });
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "redirect{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("before replying to an approval");
    expect(box()).toHaveValue("redirect");
    expect(useUi.getState().terminalContexts.t1).toEqual([terminalExcerpt]);
    expect(decide).not.toHaveBeenCalled();
    decide.mockRestore();
  });
  it("refuses a picked local command with the same retained-context behavior", async () => {
    const commands = vi.spyOn(api, "commands").mockResolvedValue([]);
    const patch = vi.spyOn(api, "patchThread").mockResolvedValue(thread);
    useUi.setState({ planControls: true });
    useUi.getState().addTerminalContext("t1", terminalExcerpt);
    setup();
    await userEvent.type(box(), "/pl");
    const option = await screen.findByRole("option", { name: /^\/plan/ });
    await userEvent.click(within(option).getByRole("button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Remove the terminal context before using /plan");
    expect(box()).toHaveValue("/pl");
    expect(useUi.getState().terminalContexts.t1).toEqual([terminalExcerpt]);
    expect(patch).not.toHaveBeenCalled();
    commands.mockRestore(); patch.mockRestore();
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

  it("shows engine and model", () => {
    render(<Composer thread={thread} engine={null} showContext />);
    expect(screen.getByText("opus")).toBeInTheDocument();
  });
});
