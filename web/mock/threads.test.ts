import { expect, it } from "vitest";
import { createMockApi } from "./api";

it("lists a checkout tree and reads files for the Files surface", () => {
  const api = createMockApi();
  const root = api.handle("GET", "/api/threads/t-approval/files?path=");
  expect(root.status).toBe(200);
  expect(Array.isArray(root.body)).toBe(true);
  expect((root.body as { path: string }[]).map((entry) => entry.path)).toContain("src");
  const nested = api.handle("GET", "/api/threads/t-approval/files?path=src");
  expect((nested.body as { path: string }[]).map((entry) => entry.path)).toEqual(["src/main.rs", "src/lib.rs"]);
  const file = api.handle("GET", "/api/threads/t-approval/files/content?path=src/main.rs");
  expect(file.body).toMatchObject({ path: "src/main.rs", binary: false, truncated: false });
  // A subpath must not fall back to the thread object, which crashed the Files tree.
  expect(api.handle("GET", "/api/threads/t-approval/previews").body).toEqual([]);
});

it("starts a side chat from a thread", () => {
  const api = createMockApi();
  const side = api.handle("POST", "/api/threads/t-approval/fork", { side: true });
  expect(side.status).toBe(201);
  expect(side.body).toMatchObject({ lifecycle: { parent_thread_id: "t-approval", relation: "side" } });
  expect(api.handle("POST", "/api/threads/missing/fork", { side: true }).status).toBe(404);
});

it("serves a thread's linked pull requests, and their refresh, as arrays", () => {
  const api = createMockApi();
  const linked = api.handle("GET", "/api/threads/t-approval/pulls");
  expect(linked.status).toBe(200);
  expect(linked.body).toEqual([expect.objectContaining({ number: 42, title: "Add approval timeouts" })]);
  const refreshed = api.handle("POST", "/api/threads/t-approval/pulls/refresh");
  expect(refreshed.status).toBe(200);
  expect(Array.isArray(refreshed.body)).toBe(true);
});
