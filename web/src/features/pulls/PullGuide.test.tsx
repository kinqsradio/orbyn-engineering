import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineStatus, PullGuideState } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { PullGuide, guideIsStale } from "./PullGuide";
import { pullsApi } from "../../api/pulls";

const navigateTo = vi.hoisted(() => vi.fn());
vi.mock("../../state/route", async (original) => ({
  ...(await original<typeof import("../../state/route")>()),
  navigate: navigateTo,
}));

const guide: NonNullable<PullGuideState["guide"]> = {
  number: 7,
  head_sha: "abc1234",
  thread_id: "t-writer",
  written_at: new Date().toISOString(),
  stops: [
    {
      title: "Entry point",
      summary: "Start with the route.",
      files: [{ path: "src/main.rs", note: "wires the route" }],
      questions: ["Is the timeout right?"],
    },
    { title: "Tests", summary: "", files: [], questions: [] },
  ],
};

beforeEach(() => {
  useWorkspace.setState({
    engines: { loading: false, error: null, data: [{ id: "codex", installed: true } as EngineStatus] },
    refreshAll: vi.fn(async () => {}),
  });
});
afterEach(() => vi.restoreAllMocks());

describe("PullGuide", () => {
  it("shows each stop in reading order with its files and questions", async () => {
    vi.spyOn(pullsApi, "guide").mockResolvedValue({ enabled: true, guide });
    render(<PullGuide projectId="p" number={7} headSha="abc1234ffff" />);
    const stops = await screen.findAllByRole("heading", { level: 3 });
    expect(stops.map((stop) => stop.textContent)).toEqual(["Entry point", "Tests"]);
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();
    expect(screen.getByText("Is the timeout right?")).toBeInTheDocument();
    expect(screen.getByText(/2 stops · written .* for abc1234/)).toBeInTheDocument();
    expect(screen.queryByText(/commits this guide does not cover/)).toBeNull();
  });

  it("says when the pull request has moved past the guide", async () => {
    vi.spyOn(pullsApi, "guide").mockResolvedValue({ enabled: true, guide });
    render(<PullGuide projectId="p" number={7} headSha="def5678" />);
    expect(await screen.findByText("The pull request has commits this guide does not cover.")).toBeInTheDocument();
    expect(guideIsStale({ ...guide, head_sha: null }, "def5678")).toBe(false);
  });

  it("starts the writing thread and opens it", async () => {
    vi.spyOn(pullsApi, "guide").mockResolvedValue({ enabled: true, guide: null });
    const write = vi.spyOn(pullsApi, "writeGuide").mockResolvedValue({ id: "t-new" });
    render(<PullGuide projectId="p" number={7} />);
    await userEvent.click(await screen.findByRole("button", { name: "Write a guide" }));
    expect(write).toHaveBeenCalledWith("p", 7, "codex");
    expect(navigateTo).toHaveBeenCalledWith({ name: "thread", id: "t-new" });
  });

  it("offers no writing while guides are off", async () => {
    vi.spyOn(pullsApi, "guide").mockResolvedValue({ enabled: false, guide: null });
    render(<PullGuide projectId="p" number={7} />);
    expect(await screen.findByText(/Review guides are off for this project/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens a thread about one stop with the stop as its draft", async () => {
    vi.spyOn(pullsApi, "guide").mockResolvedValue({ enabled: true, guide });
    const thread = { id: "t-ask" };
    const ask = vi
      .spyOn(pullsApi, "askAboutStop")
      .mockResolvedValue({ thread, draft: "About stop 2: Tests\n\nMy question: " } as Awaited<ReturnType<typeof pullsApi.askAboutStop>>);
    render(<PullGuide projectId="p" number={7} />);
    await userEvent.click(await screen.findByRole("button", { name: "Ask about Tests" }));
    expect(ask).toHaveBeenCalledWith("p", 7, "codex", 1);
    expect(useUi.getState().drafts["t-ask"]).toBe("About stop 2: Tests\n\nMy question: ");
    expect(navigateTo).toHaveBeenCalledWith({ name: "thread", id: "t-ask" });
  });
});
