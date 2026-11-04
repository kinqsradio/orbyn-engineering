import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, request } from "../../api/client";
import type { PullRequest } from "../../api/types";
import { threads } from "../../../mock/fixtures";
import { useWorkspace } from "../../state/workspace";
import { pullChecks, pullPreviewPlacement, pullReview, pullState } from "../pulls/PullLinkPreview";
import { pullNumberOf, pullRepositoryLabel, samePullRequest } from "../pulls/pullLink";
import { Markdown } from "./Markdown";
import { previewProjectId } from "./MarkdownLink";

vi.mock("../../api/client", async (original) => ({ ...(await original<object>()), request: vi.fn() }));
const mock = vi.mocked(request);
const href = "https://github.com/acme/orbyn/pull/42";

const pull = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 42,
  title: "Fix the hover card",
  url: href,
  state: "open",
  head: "fix",
  base: "main",
  author: "ada",
  draft: false,
  updated_at: new Date().toISOString(),
  labels: [],
  review_state: "review_required",
  checks_state: "pass",
  ...over,
});

const respond = (entry = pull()) =>
  mock.mockResolvedValue({
    pull: entry,
    body: "",
    checks: null,
    comments: null,
    mergeable: null,
    reviewers: [],
    head_sha: null,
    base_sha: null,
    additions: null,
    deletions: null,
    changed_files: null,
    maintainer_can_modify: null,
    auto_merge: false,
  } as never);

const hover = async (link: HTMLElement, ms = 350) => {
  fireEvent.pointerEnter(link, { pointerType: "mouse" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  mock.mockReset();
  useWorkspace.setState({
    threads: Object.fromEntries(threads().map((thread) => [thread.id, thread])),
  });
  window.location.hash = "#/threads/t-approval";
});

afterEach(() => vi.useRealTimers());

describe("pull link addresses", () => {
  it("reads the number, repository and host from a host's address", () => {
    expect(pullNumberOf(href)).toBe(42);
    expect(pullNumberOf("https://github.com/o/r/pull/42/files#x")).toBe(42);
    expect(pullNumberOf("https://example.com/docs")).toBeNull();
    expect(pullRepositoryLabel(href)).toBe("acme/orbyn");
    expect(pullRepositoryLabel("not a url")).toBeNull();
  });

  it("matches only the same pull request in the same repository", () => {
    expect(samePullRequest("https://github.com/Acme/Orbyn/pull/42/files", href)).toBe(true);
    expect(samePullRequest("https://github.com/acme/other/pull/42", href)).toBe(false);
    expect(samePullRequest("https://github.com/acme/orbyn/pull/43", href)).toBe(false);
    expect(samePullRequest("https://example.com/docs", href)).toBe(false);
  });
});

describe("pull link preview", () => {
  it("shows the title, state, author and checks after a short hover", async () => {
    respond();
    render(<Markdown text={`See [the fix](${href}).`} projectId="p-app" />);
    const link = screen.getByRole("link", { name: "the fix" });
    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(mock).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mock).toHaveBeenCalledWith("GET", "/api/projects/p-app/pulls/42", undefined, expect.anything());
    const card = screen.getByRole("tooltip");
    expect(card).toHaveTextContent("Fix the hover card");
    expect(card).toHaveTextContent("acme/orbyn#42 · Open");
    expect(card).toHaveTextContent("ada");
    expect(card).toHaveTextContent("Checks passing");
    expect(card).toHaveTextContent("Awaiting review");
  });

  it("uses the current thread's project when the prose has no project", async () => {
    respond();
    render(<Markdown text={`See [the fix](${href}).`} />);
    await hover(screen.getByRole("link", { name: "the fix" }));
    expect(mock).toHaveBeenCalledWith("GET", "/api/projects/p-app/pulls/42", undefined, expect.anything());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fix the hover card");
  });

  it("leaves before the delay without a request or a card", async () => {
    const link = (() => {
      render(<Markdown text={`See [the fix](${href}).`} projectId="p-app" />);
      return screen.getByRole("link", { name: "the fix" });
    })();
    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.pointerLeave(link);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mock).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays quiet for other links, touch pointers and routes without a project", async () => {
    render(<Markdown text={"[docs](https://example.com/docs)"} projectId="p-app" />);
    await hover(screen.getByRole("link", { name: "docs" }));
    expect(mock).not.toHaveBeenCalled();

    const pr = (() => {
      render(<Markdown text={`[the fix](${href})`} projectId="p-app" />);
      return screen.getByRole("link", { name: "the fix" });
    })();
    fireEvent.pointerEnter(pr, { pointerType: "touch" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mock).not.toHaveBeenCalled();

    window.location.hash = "#/pulls";
    render(<Markdown text={`[other](${href})`} />);
    await hover(screen.getByRole("link", { name: "other" }));
    expect(mock).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hides the card when the project answers with another pull request", async () => {
    respond(pull({ url: "https://github.com/acme/other/pull/42" }));
    render(<Markdown text={`[the fix](${href})`} projectId="p-app" />);
    await hover(screen.getByRole("link", { name: "the fix" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hides the card when the pull request cannot be read", async () => {
    mock.mockRejectedValue(new ApiFailure("not_found", "No such pull request.", 404));
    render(<Markdown text={`[the fix](${href})`} projectId="p-app" />);
    await hover(screen.getByRole("link", { name: "the fix" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("pull link presentation", () => {
  it("names draft, merged, closed and open states", () => {
    expect(pullState({ state: "open", draft: true }).label).toBe("Draft");
    expect(pullState({ state: "merged", draft: false }).label).toBe("Merged");
    expect(pullState({ state: "closed", draft: false }).label).toBe("Closed");
    expect(pullState({ state: "open", draft: false }).label).toBe("Open");
  });

  it("names checks and review outcomes, and omits the absent ones", () => {
    expect(pullChecks("pass")?.label).toBe("Checks passing");
    expect(pullChecks("fail")?.label).toBe("Checks failing");
    expect(pullChecks("pending")?.label).toBe("Checks running");
    expect(pullChecks("none")).toBeNull();
    expect(pullReview("approved")?.label).toBe("Approved");
    expect(pullReview("changes_requested")?.label).toBe("Changes requested");
    expect(pullReview("review_required")?.label).toBe("Awaiting review");
    expect(pullReview(null)).toBeNull();
  });

  it("places the card below a link, above one near the bottom, and inside the viewport", () => {
    const viewport = { width: 1024, height: 768 };
    expect(pullPreviewPlacement({ left: 100, top: 100, bottom: 120 }, viewport)).toEqual({
      left: 100,
      top: 126,
      above: false,
    });
    expect(pullPreviewPlacement({ left: 1000, top: 700, bottom: 720 }, viewport)).toEqual({
      left: 696,
      top: 694,
      above: true,
    });
  });

  it("reads the project from a thread route only", () => {
    expect(previewProjectId("#/threads/t-approval")).toBe("p-app");
    expect(previewProjectId("#/pulls")).toBeNull();
    expect(previewProjectId("#/threads/missing")).toBeNull();
  });
});
