import { act, render } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ProjectBadge } from "./badges";
import { useWorkspace } from "../state/workspace";
import { projects, workspaceStatus } from "../../mock/fixtures";
import type { Project } from "../api/types";
const images = vi.hoisted(() => ({
  subscribe: vi.fn<(key: string, project: { id: string; path: string }, listener: () => void) => () => void>(() => () => {}),
  read: vi.fn<() => string | null>(() => null),
}));
vi.mock("../lib/projectImages", () => ({
  projectImageKey: (project: { id: string; path: string; favicon_path?: string | null }) => JSON.stringify([project.id, project.path, project.favicon_path ?? null]),
  readProjectImage: images.read, subscribeProjectImage: images.subscribe,
  rejectProjectImage: vi.fn(), invalidateProjectImages: vi.fn(),
}));
const workspace = workspaceStatus(projects);
const normal: Project = { ...projects[0]!, trusted: false };
const library: Project = { ...normal, id: "library", name: "Skills library", path: workspace.library!.path };
const ready = (loading = false) => useWorkspace.setState({ managed: { data: workspace, error: null, loading } });
beforeEach(() => {
  vi.clearAllMocks(); images.read.mockReturnValue(null); vi.useFakeTimers();
  useWorkspace.setState({ managed: { data: null, error: null, loading: true } });
});
afterEach(() => vi.useRealTimers());

it("waits for the known library and subscribes only ordinary registered projects", () => {
  const sameBasename: Project = { ...normal, id: "same-basename", path: `/another/${workspace.library!.path.split(/[\\/]/).at(-1)}` };
  render(<><ProjectBadge name={library.name} project={library} /><ProjectBadge name={normal.name} project={normal} /><ProjectBadge name="Other" project={sameBasename} /></>);
  act(() => { vi.advanceTimersByTime(120_000); });
  expect(images.subscribe).not.toHaveBeenCalled();
  act(() => ready());
  expect(images.subscribe).toHaveBeenCalledTimes(2);
  const ids = images.subscribe.mock.calls.map((call) => JSON.parse(call[0])[0] as string);
  expect(ids).toEqual(expect.arrayContaining([normal.id, sameBasename.id]));
  expect(ids).not.toContain(library.id);
});

it("keeps unconfigured workspaces, scratch and name-only identities on automatic fallback", () => {
  useWorkspace.setState({ managed: { data: { ...workspace, configured: false, library: null }, error: null, loading: false } });
  const rendered = render(<><ProjectBadge name="Plain" /><ProjectBadge name="Scratch" project={{ ...normal, scratch: true }} /><ProjectBadge name={normal.name} project={normal} /></>);
  expect(images.subscribe).not.toHaveBeenCalled();
  act(() => ready());
  expect(images.subscribe).toHaveBeenCalledTimes(1);
  expect(rendered.container.querySelectorAll(".project-monogram")).toHaveLength(3);
});

it("retained workspace metadata keeps images stable through normal polling", () => {
  ready(); images.read.mockReturnValue("data:image/png;base64,aGVsbG8=");
  const rendered = render(<ProjectBadge name={normal.name} project={normal} />);
  expect(rendered.container.querySelector("img")).not.toBeNull();
  const subscriptions = images.subscribe.mock.calls.length;
  act(() => ready(true));
  expect(rendered.container.querySelector("img")).not.toBeNull();
  expect(images.subscribe).toHaveBeenCalledTimes(subscriptions);
});

it("hides an old image when the registered identity becomes the library", () => {
  ready(); images.read.mockReturnValue("data:image/png;base64,aGVsbG8=");
  const rendered = render(<ProjectBadge name={normal.name} project={normal} />);
  expect(rendered.container.querySelector("img")).not.toBeNull();
  act(() => useWorkspace.setState({ managed: { data: { ...workspace, library: { ...workspace.library!, path: normal.path } }, error: null, loading: false } }));
  expect(rendered.container.querySelector("img")).toBeNull();
  expect(rendered.container.querySelector(".project-monogram")).not.toBeNull();
});


it("structured identities take priority without subscribing to passive images", () => {
  ready(); images.read.mockReturnValue("data:image/png;base64,aGVsbG8=");
  const rendered = render(<><ProjectBadge name={normal.name} project={{ ...normal, project_icon: { kind: "emoji", emoji: "🚀✨" } }} />
    <ProjectBadge name={normal.name} project={{ ...normal, project_icon: { kind: "monogram", text: "aé", color: "teal" } }} /></>);
  expect(images.subscribe).not.toHaveBeenCalled();
  expect(rendered.container.querySelector("img")).toBeNull();
  expect(rendered.container.textContent).toBe("🚀✨aé");
});

it("resetting a structured override resumes the registered image observation", () => {
  ready(); images.read.mockReturnValue("data:image/png;base64,aGVsbG8=");
  const rendered = render(<ProjectBadge name={normal.name} project={{ ...normal, project_icon: { kind: "emoji", emoji: "🚀" } }} />);
  expect(images.subscribe).not.toHaveBeenCalled();
  rendered.rerender(<ProjectBadge name={normal.name} project={{ ...normal, project_icon: null }} />);
  expect(images.subscribe).toHaveBeenCalledTimes(1);
  expect(rendered.container.querySelector("img")).not.toBeNull();
});

it("observes the saved relative image hint and resubscribes when it changes", () => {
  ready();
  const first = { ...normal, favicon_path: "assets/first.png" };
  const rendered = render(<ProjectBadge name={first.name} project={first} />);
  expect(images.subscribe.mock.calls.at(-1)?.[1]).toMatchObject({ favicon_path: "assets/first.png" });
  rendered.rerender(<ProjectBadge name={first.name} project={{ ...first, favicon_path: "second.svg" }} />);
  expect(images.subscribe.mock.calls.at(-1)?.[1]).toMatchObject({ favicon_path: "second.svg" });
});
