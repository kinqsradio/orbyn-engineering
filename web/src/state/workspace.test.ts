import { describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import * as projectImages from "../lib/projectImages";
import { projects } from "../../mock/fixtures";
import type { Approval } from "../api/types";
import { useWorkspace } from "./workspace";

const approval = (id: string) => ({ id }) as Approval;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("workspace store", () => {
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
