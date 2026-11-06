import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { api, request } from "../../api/client";
import { HistoryImport } from "./HistoryImport";

vi.mock("../../api/client", async (original) => {
  const actual = await original<typeof import("../../api/client")>();
  return { ...actual, request: vi.fn(), api: { ...actual.api, addProject: vi.fn() } };
});

const session = (patch: object) => ({
  engine: "claude", session_id: "s1", title: "Fix the login bug", cwd: "/work", updated_at: "2026-11-06T10:00:00Z",
  project_id: "p1", importable: true, thread_id: null, ...patch,
});

it("scans only when asked and offers import only for trusted projects", async () => {
  const user = userEvent.setup();
  vi.mocked(request).mockImplementation(async (method, path) => {
    if (method === "GET" && path === "/api/history/sessions") {
      return { truncated: false, sessions: [session({}), session({ session_id: "s2", title: "Elsewhere", project_id: null, importable: false }), session({ session_id: "s3", title: "Done before", thread_id: "t9" })] };
    }
    if (method === "POST" && path === "/api/history/import") return { thread_id: "t1", imported: true };
    return [];
  });
  render(<HistoryImport />);
  expect(request).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Find conversations" }));
  expect(await screen.findByText("Fix the login bug")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add folder" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import" }));
  expect(request).toHaveBeenCalledWith("POST", "/api/history/import", { engine: "claude", session_id: "s1" });
  expect(window.location.hash).toBe("#/threads/t1");
});

it("adds a session's folder as a project, which then needs trust", async () => {
  const user = userEvent.setup();
  let added = false;
  vi.mocked(api.addProject).mockImplementation(async () => {
    added = true;
    return { id: "p2" } as Awaited<ReturnType<typeof api.addProject>>;
  });
  vi.mocked(request).mockImplementation(async (method, path) => {
    if (method === "GET" && path === "/api/history/sessions") {
      return { truncated: false, sessions: [session(added ? { project_id: "p2", importable: false } : { project_id: null, importable: false })] };
    }
    return [];
  });
  render(<HistoryImport />);
  await user.click(screen.getByRole("button", { name: "Find conversations" }));
  await user.click(await screen.findByRole("button", { name: "Add folder" }));
  expect(api.addProject).toHaveBeenCalledWith("/work");
  await user.click(await screen.findByRole("button", { name: "Trust folder" }));
  expect(window.location.hash).toBe("#/trust/p2");
});
