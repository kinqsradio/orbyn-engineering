import { expect, it } from "vitest";
import { createMockApi } from "./api";
import type { ScopedPreferencesResult } from "../src/generated/ScopedPreferencesResult";

it("serves scoped reads for app fixtures and keeps stale selections unavailable", () => {
  const api = createMockApi();
  const initial = api.handle("POST", "/api/settings/preferences/query", { scope: {}, keys: ["branch_name_prefix"] });
  expect(initial.status).toBe(200);
  const result = initial.body as ScopedPreferencesResult;
  expect(result.catalog.selection).toEqual({ kind: "all_projects" });
  expect(result.rows[0]?.value).toBe("feat");
  const changed = api.handle("PUT", "/api/settings/preferences", {
    scope: {}, membership_version: result.catalog.version,
    if_match: { branch_name_prefix: result.rows[0]?.revision }, edits: { branch_name_prefix: { op: "set", value: "fix" } },
  });
  expect(changed.status).toBe(200);
  expect((changed.body as ScopedPreferencesResult).rows[0]?.value).toBe("fix");
  const unavailable = api.handle("POST", "/api/settings/project-scopes", { selection: { kind: "project_group", group_key: "removed" } });
  expect(unavailable.body).toMatchObject({ selection: { kind: "unavailable", reason: "project_missing" } });
  expect(api.handle("POST", "/api/settings/preferences/query", { scope: { selection: { kind: "project_group", group_key: "removed" } }, keys: ["branch_name_prefix"] }).status).toBe(409);
  api.reset();
});
