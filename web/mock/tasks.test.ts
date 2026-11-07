import { expect, it } from "vitest";
import { createMockApi } from "./api";

it("serves the task list only at the collection, and each subpath its own shape", () => {
  const api = createMockApi();
  const list = api.handle("GET", "/api/tasks");
  expect(list.status).toBe(200);
  expect(list.body).toHaveLength(3);

  // A subpath must not fall back to the whole task array: the deliveries
  // dialog would render every task as a delivery.
  const deliveries = api.handle("GET", "/api/tasks/task-hook/deliveries");
  expect(deliveries.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: "dlv-1", from: "GitHub" })]));
  expect(api.handle("GET", "/api/tasks/task-hook/runs").body).toHaveLength(8);
  expect(api.handle("GET", "/api/tasks/task-hook").status).toBe(404);
});
