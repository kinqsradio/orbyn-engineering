import { describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import * as projectImages from "../lib/projectImages";
import { projects } from "../../mock/fixtures";
import type { Approval, Project } from "../api/types";
import { useWorkspace } from "./workspace";

const approval = (id: string) => ({ id }) as Approval;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("workspace store", () => {
  it.each(["icon", "name"] as const)("keeps a committed %s edit when an older project refresh arrives", async (field) => {
    const original: Project = { ...projects[0]!, name: "Before commit", metadata_revision: "4", project_icon: null };
    const peer: Project = { ...original, id: "peer", path: "/peer", name: "Peer" };
    const committed: Project = { ...original, metadata_revision: "5",
      ...(field === "icon" ? { project_icon: { kind: "emoji", emoji: "🚀" } as const } : { name: "Committed name" }) };
    useWorkspace.setState({ projects: { data: [original, peer], error: null, loading: false } });
    const stale = deferred<Project[]>();
    const spy = vi.spyOn(api, "projects").mockReturnValueOnce(stale.promise);
    try {
      const refresh = useWorkspace.getState().refreshProjects();
      expect(useWorkspace.getState().projects.loading).toBe(true);
      useWorkspace.getState().putProject(committed);
      const loadingAtCommit = useWorkspace.getState().projects.loading;
      stale.resolve([original, peer]);
      await refresh;
      expect(useWorkspace.getState().projects).toEqual({ data: [committed, peer], error: null, loading: false });
      expect(loadingAtCommit).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("keeps a committed deletion when an older project refresh arrives", async () => {
    const removed: Project = { ...projects[0]!, metadata_revision: "4" };
    const peer: Project = { ...removed, id: "peer", path: "/peer", name: "Peer" };
    useWorkspace.setState({ projects: { data: [removed, peer], error: null, loading: false } });
    const stale = deferred<Project[]>();
    const spy = vi.spyOn(api, "projects").mockReturnValueOnce(stale.promise);
    try {
      const refresh = useWorkspace.getState().refreshProjects();
      expect(useWorkspace.getState().projects.loading).toBe(true);
      useWorkspace.getState().dropProject(removed.id);
      const loadingAtCommit = useWorkspace.getState().projects.loading;
      stale.resolve([removed, peer]);
      await refresh;
      expect(useWorkspace.getState().projects).toEqual({ data: [peer], error: null, loading: false });
      expect(loadingAtCommit).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("ignores a stale response that arrives last", async () => {
    const first = deferred<Approval[]>();
    const second = deferred<Approval[]>();
    const spy = vi
      .spyOn(api, "pendingApprovals")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const a = useWorkspace.getState().refreshApprovals();
    const b = useWorkspace.getState().refreshApprovals();
    second.resolve([approval("new")]);
    await b;
    first.resolve([approval("old")]);
    await a;
    expect(useWorkspace.getState().approvals.data?.map((x) => x.id)).toEqual(["new"]);
    spy.mockRestore();
  });

  it("keeps the last data when a refresh fails", async () => {
    useWorkspace.setState({ approvals: { data: [approval("a")], error: null, loading: false } });
    const spy = vi.spyOn(api, "pendingApprovals").mockRejectedValueOnce(new Error("down"));
    await useWorkspace.getState().refreshApprovals();
    const { data, error } = useWorkspace.getState().approvals;
    expect(data?.map((x) => x.id)).toEqual(["a"]);
    expect(error).not.toBeNull();
    spy.mockRestore();
  });

  it("removes a decided approval from the pending list and keeps the receipt", () => {
    useWorkspace.setState({ approvals: { data: [approval("a")], error: null, loading: false } });
    useWorkspace.getState().putReceipt({ ...approval("a"), state: "allowed" });
    expect(useWorkspace.getState().approvals.data).toEqual([]);
    expect(useWorkspace.getState().receipts.a?.state).toBe("allowed");
  });
});


it("invalidates passive image observations when committed or polled icon metadata changes", async () => {
  const project = { ...projects[0]!, project_icon: null, favicon_path: null };
  useWorkspace.setState({ projects: { data: [project], error: null, loading: false } });
  const invalidateProjectImages = vi.spyOn(projectImages, "invalidateProjectImages");
  useWorkspace.getState().putProject({ ...project, name: "Renamed", metadata_revision: "1" });
  expect(invalidateProjectImages).not.toHaveBeenCalled();
  const icon = { kind: "emoji" as const, emoji: "🚀" };
  useWorkspace.getState().putProject({ ...project, project_icon: icon, metadata_revision: "2" });
  expect(invalidateProjectImages).toHaveBeenCalledExactlyOnceWith(project.id);
  vi.mocked(invalidateProjectImages).mockClear();
  const spy = vi.spyOn(api, "projects").mockResolvedValue([{ ...project, metadata_revision: "3" }]);
  try {
    await useWorkspace.getState().refreshProjects();
    expect(invalidateProjectImages).toHaveBeenCalledExactlyOnceWith(project.id);
    vi.mocked(invalidateProjectImages).mockClear();
    await useWorkspace.getState().refreshProjects();
    expect(invalidateProjectImages).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); invalidateProjectImages.mockRestore(); }
});


it("does not replace a newer committed project with an older mutation response", () => {
  const older: Project = { ...projects[0]!, name: "Before rename", metadata_revision: "4", favicon_path: "brand/icon.svg" };
  const newer: Project = { ...older, name: "After rename", metadata_revision: "5" };
  useWorkspace.setState({ projects: { data: [older], error: null, loading: false } });
  useWorkspace.getState().putProject(newer);
  useWorkspace.getState().putProject(older);
  expect(useWorkspace.getState().projects.data).toEqual([newer]);
});


it("orders committed project revisions exactly above JavaScript's integer range", () => {
  const newer: Project = { ...projects[0]!, name: "Newer", metadata_revision: "9007199254740993" };
  useWorkspace.setState({ projects: { data: [newer], error: null, loading: false } });
  useWorkspace.getState().putProject({ ...newer, name: "Older", metadata_revision: "9007199254740992" });
  expect(useWorkspace.getState().projects.data).toEqual([newer]);
});

it("does not replace observed versioned project metadata with an unversioned reply", () => {
  const newer: Project = { ...projects[0]!, name: "Observed", metadata_revision: "0" };
  useWorkspace.setState({ projects: { data: [newer], error: null, loading: false } });
  useWorkspace.getState().putProject({ ...newer, name: "Unversioned", metadata_revision: undefined });
  expect(useWorkspace.getState().projects.data).toEqual([newer]);
});
