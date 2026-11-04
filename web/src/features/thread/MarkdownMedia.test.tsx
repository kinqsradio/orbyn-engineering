import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../../api/types";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Markdown } from "./Markdown";
import { resolveMediaSource, workspacePath } from "./mediaSource";

const atThread = () => {
  window.location.hash = "#/threads/t1";
};

const thread: Thread = {
  id: "t1",
  project_id: "p",
  title: "Thread",
  engine: "codex",
  model: null,
  cwd: "/Users/me/checkout",
  worktree: null,
  skill_profile: null,
  scratch: false,
  active_run: null,
  last_run_state: null,
  created_at: "",
  updated_at: "",
};

const toastTexts = () => useUi.getState().toasts.map((toast) => toast.text);

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

describe("media sources", () => {
  it("normalises separators and keeps a path inside the thread's root", () => {
    expect(workspacePath("docs\\shot.png", null)).toBe("docs/shot.png");
    expect(workspacePath("./out/run.mp4", null)).toBe("out/run.mp4");
    expect(workspacePath("/repo/docs/a.png", "/repo/")).toBe("docs/a.png");
    expect(workspacePath("C:\\repo\\docs\\a.png", "c:/repo")).toBe("docs/a.png");
    expect(workspacePath("/elsewhere/a.png", "/repo")).toBeNull();
    expect(workspacePath("/repo", "/repo")).toBeNull();
    expect(workspacePath("docs/a.png", null)).toBe("docs/a.png");
  });

  it("refuses a scheme that is not a drive letter", () => {
    expect(workspacePath("data:image/png;base64,AAAA", null)).toBeNull();
    expect(workspacePath("javascript:alert/x.png", null)).toBeNull();
    expect(workspacePath("file:///repo/a.png", null)).toBeNull();
    expect(workspacePath("docs/a b.png", null)).toBeNull();
  });

  it("resolves only images and videos of the thread's checkout", () => {
    const scoped = { id: "t1", cwd: "/Users/me/checkout" };
    expect(resolveMediaSource("docs/a.png", "a", scoped)).toMatchObject({
      kind: "image",
      src: "/api/threads/t1/files/raw?path=docs%2Fa.png",
      path: "docs/a.png",
      threadId: "t1",
    });
    expect(resolveMediaSource("out/run.mp4", "", scoped)?.kind).toBe("video");
    expect(resolveMediaSource("docs/report.pdf", "a", scoped)).toBeNull();
    expect(resolveMediaSource("docs/a.png", "a", null)).toBeNull();
    expect(resolveMediaSource("https://example.com/a.png", "a", null)).toMatchObject({
      kind: "image",
      src: "https://example.com/a.png",
    });
  });

  it("plays a remote video file and refuses a scheme that is not a page load", () => {
    expect(resolveMediaSource("https://example.com/clip.mp4?v=1", "a", null)?.kind).toBe("video");
    expect(resolveMediaSource("https://example.com/a.png", "a", null)?.kind).toBe("image");
    expect(resolveMediaSource("mailto:ada@example.com", "a", null)).toBeNull();
  });
});

describe("media in messages", () => {
  it("serves a workspace image from the thread's raw route", () => {
    atThread();
    const { container } = render(<Markdown text="![shot](docs/shot.png)" />);
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", "/api/threads/t1/files/raw?path=docs%2Fshot.png");
    expect(image).toHaveAttribute("alt", "shot");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("docs/shot.png");
  });

  it("leaves a workspace path as text outside a thread", () => {
    const { container } = render(<Markdown text="![shot](docs/shot.png)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("![shot](docs/shot.png)");
  });

  it("reads backslashes and an absolute path inside the checkout", () => {
    atThread();
    useWorkspace.setState({ threads: { t1: thread } });
    const { container } = render(
      <Markdown text={"![a](docs\\shot.png)\n\n![b](/Users/me/checkout/out/run.mp4)"} />,
    );
    const [image, video] = [...container.querySelectorAll("img, video")];
    expect(image).toHaveAttribute("src", "/api/threads/t1/files/raw?path=docs%2Fshot.png");
    expect(video).toHaveAttribute("src", "/api/threads/t1/files/raw?path=out%2Frun.mp4");
  });

  it("leaves an absolute path outside the checkout as text", () => {
    atThread();
    useWorkspace.setState({ threads: { t1: thread } });
    const { container } = render(<Markdown text="![shot](/elsewhere/shot.png)" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("![shot](/elsewhere/shot.png)");
  });

  it("renders a video with controls and no autoplay", () => {
    atThread();
    const { container } = render(<Markdown text={"![](out/run.mp4)"} />);
    const video = container.querySelector("video");
    expect(video).toHaveAttribute("src", "/api/threads/t1/files/raw?path=out%2Frun.mp4");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("autoplay");
    expect(container.querySelector("img")).toBeNull();
  });

  it("never turns an unsafe scheme into media", () => {
    atThread();
    const { container } = render(
      <Markdown
        text={"![a](data:image/png;base64,AAAA)\n\n![b](javascript:alert/x.png)\n\n![c](vbscript:x.png)"}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("javascript:alert/x.png");
  });

  it("keeps partial markdown as text while it streams", () => {
    atThread();
    const { container } = render(<Markdown text={"![shot](docs/sh"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("![shot](docs/sh");
  });

  it("shows a readable fallback when media cannot load", () => {
    atThread();
    const { container } = render(<Markdown text={"![shot](docs/shot.png)\n\n![](out/run.mp4)"} />);
    const image = container.querySelector("img");
    const video = container.querySelector("video");
    if (!image || !video) throw new Error("media did not render");
    fireEvent.error(image);
    fireEvent.error(video);
    expect(screen.getByText("Image unavailable · shot")).toBeInTheDocument();
    expect(screen.getByText("Video unavailable")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
  });
});

describe("the expanded view", () => {
  it("walks every media item of one message", async () => {
    const user = userEvent.setup();
    atThread();
    render(<Markdown text={"![one](docs/one.png)\n\n![two](docs/two.png)\n\n![three](docs/three.png)"} />);
    const expandable = screen.getAllByRole("button", { name: /^Expand / });
    expect(expandable).toHaveLength(3);
    await user.click(expandable[1]!);
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Next"));
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Previous"));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("2 of 3")).not.toBeInTheDocument();
  });

  it("collects remote and checkout media into one gallery", async () => {
    const user = userEvent.setup();
    atThread();
    render(<Markdown text={"![pic](https://example.com/a.png)\n\n![shot](docs/shot.png)"} />);
    await user.click(screen.getByLabelText("Expand shot"));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Previous"));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Open in new tab")).toHaveAttribute("href", "https://example.com/a.png");
    expect(screen.queryByText("Save")).toBeNull();
  });

  it("stays inside the message it was opened from", async () => {
    const user = userEvent.setup();
    atThread();
    render(
      <>
        <Markdown text={"![one](docs/one.png)\n\n![two](docs/two.png)"} />
        <Markdown text={"![three](docs/three.png)"} />
      </>,
    );
    await user.click(screen.getByLabelText("Expand one"));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("shows no counter for a single item and closes from its button", async () => {
    const user = userEvent.setup();
    atThread();
    render(<Markdown text={"![](out/run.mp4)"} />);
    await user.click(screen.getByLabelText("Expand video"));
    expect(screen.queryByText(/\d of \d/)).toBeNull();
    expect(document.querySelector(".lightbox-stage video")).toHaveAttribute("controls");
    expect(screen.getByLabelText("Copy image")).toBeDisabled();
    await user.click(screen.getByLabelText("Close"));
    expect(document.querySelector(".lightbox-stage video")).toBeNull();
  });

  it("saves through the download route and copies the path", async () => {
    const user = userEvent.setup();
    atThread();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"![shot](docs/shot.png)"} />);
    await user.click(screen.getByLabelText("Expand shot"));
    const save = screen.getByText("Save");
    expect(save).toHaveAttribute("href", "/api/threads/t1/files/raw?path=docs%2Fshot.png&download=true");
    expect(save).toHaveAttribute("download", "shot.png");
    // jsdom would try to navigate the download; the browser hands it to the download manager instead.
    const swallow = (event: Event) => event.preventDefault();
    document.addEventListener("click", swallow);
    try {
      await user.click(save);
    } finally {
      document.removeEventListener("click", swallow);
    }
    await waitFor(() => expect(toastTexts()).toContain("Download started"));
    await user.click(screen.getByLabelText("Copy path"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("docs/shot.png"));
    await waitFor(() => expect(toastTexts()).toContain("Path copied"));
  });

  it("writes the image bytes to the clipboard when the browser can", async () => {
    const user = userEvent.setup();
    atThread();
    const write = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
    vi.stubGlobal("ClipboardItem", class {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([new Uint8Array([1])], { type: "image/png" }),
    })));
    render(<Markdown text={"![shot](docs/shot.png)"} />);
    await user.click(screen.getByLabelText("Expand shot"));
    await user.click(screen.getByLabelText("Copy image"));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastTexts()).toContain("Image copied"));
    expect(fetch).toHaveBeenCalledWith("/api/threads/t1/files/raw?path=docs%2Fshot.png", {
      credentials: "same-origin",
    });
  });

  it("disables the clipboard actions the browser cannot honour", async () => {
    const user = userEvent.setup();
    atThread();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<Markdown text={"![shot](docs/shot.png)"} />);
    await user.click(screen.getByLabelText("Expand shot"));
    expect(screen.getByLabelText("Copy path")).toBeDisabled();
    expect(screen.getByLabelText("Copy image")).toBeDisabled();
    expect(screen.getByText("Save")).toHaveAttribute(
      "href",
      "/api/threads/t1/files/raw?path=docs%2Fshot.png&download=true",
    );
  });

  it("offers a new tab rather than a cross-origin download", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<Markdown text={"![pic](https://example.com/a.png)"} />);
    await user.click(screen.getByLabelText("Expand pic"));
    const open = screen.getByText("Open in new tab");
    expect(open).toHaveAttribute("href", "https://example.com/a.png");
    expect(open).toHaveAttribute("target", "_blank");
    expect(screen.queryByText("Save")).toBeNull();
    await user.click(screen.getByLabelText("Copy link"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://example.com/a.png"));
    await waitFor(() => expect(toastTexts()).toContain("Link copied"));
  });

  it("keeps the zoom controls working for images", async () => {
    const user = userEvent.setup();
    atThread();
    render(<Markdown text={"![shot](docs/shot.png)"} />);
    await user.click(screen.getByLabelText("Expand shot"));
    expect(screen.getByText("100%")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByText("125%")).toBeInTheDocument();
    expect(document.querySelector(".lightbox-stage img")).toHaveStyle({ transform: "scale(1.25)" });
    await user.click(screen.getByLabelText("Zoom out"));
    await user.click(screen.getByLabelText("Zoom out"));
    expect(screen.getByText("75%")).toBeInTheDocument();
  });
});