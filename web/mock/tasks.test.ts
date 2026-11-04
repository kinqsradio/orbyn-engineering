import { expect, it } from "vitest";
import { createMockApi } from "./api";

it("serves the task list only at the collection and deliveries as an empty list", () => {
  const api = createMockApi();
  const list = api.handle("GET", "/api/tasks");
  expect(list.status).toBe(200);
  expect(list.body).toHaveLength(3);

  // A subpath must not fall back to the whole task array: the deliveries
  // dialog would render every task as a delivery.
  expect(api.handle("GET", "/api/tasks/task-hook/deliveries")).toEqual({ status: 200, body: [] });
  expect(api.handle("GET", "/api/tasks/task-hook").status).toBe(404);
});
