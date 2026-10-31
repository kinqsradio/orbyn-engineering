import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../../api/client";
import type { Run, Thread } from "../../api/types";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { Composer } from "./Composer";

const thread: Thread = {
  id: "t1",
  project_id: "p",
  title: "Thread",
  engine: "claude",
  model: "opus",
  cwd: "/r",
  worktree: null,
  skill_profile: null,
  active_run: null,
  last_run_state: null,
  created_at: "",
  updated_at: "",
};

const run = { id: "r1" } as Run;
const box = () => screen.getByRole("textbox");

function setup(over: Partial<Thread> = {}) {
  vi.spyOn(api, "thread").mockResolvedValue(thread);
  return render(<Composer thread={{ ...thread, ...over }} engine={null} profileName={null} />);
}

describe("Composer", () => {
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

  it("blocks sending during an active run but keeps typing", async () => {
    const start = vi.spyOn(api, "startRun").mockResolvedValue(run);
    setup({ active_run: { ...run, state: "running" } as Run });
    await userEvent.type(box(), "later{Enter}");
    expect(box()).toHaveValue("later");
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    start.mockRestore();
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
    const mentions = vi.spyOn(api, "mentions").mockResolvedValue({ skills: ["architect"], files: [] });
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
    const mentions = vi.spyOn(api, "mentions").mockResolvedValue({ skills: [], files: ["src/main.rs"] });
    const commands = vi.spyOn(api, "commands").mockResolvedValue([{ name: "review", description: "Review the diff" }]);
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
    await waitFor(() => expect(start).toHaveBeenCalledWith("t1", "look", ["a1"]));
    upload.mockRestore();
    start.mockRestore();
  });

  it("shows engine, model and profile", () => {
    render(<Composer thread={thread} engine={null} profileName="Backend" />);
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
  });
});
