import type { PreferenceView } from "../../api/types";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";

export function preferenceCatalog(ids: string[] = [], project?: string): ProjectScopeCatalog {
  return { version: "catalog", metadata_complete: true,
    selection: project ? { kind: "checkout", group_key: `group-${project}`, project_id: project } : { kind: "all_projects" },
    groups: ids.map((id) => ({ key: `group-${id}`, label: id, members: [{ project_id: id,
      physical_key: id, name: id, path: `/fixture/${id}`, repository_key: id, repository_label: id,
      repository_relative_path: "", grouping_mode: "repository", metadata_complete: true, unavailable: null }] })) };
}

export function scopedFixture(views: PreferenceView[], environment = views, project?: string): ScopedPreferencesResult {
  return { catalog: preferenceCatalog(project ? [project] : [], project), rows: views.map((view) => {
    const global = environment.find((candidate) => candidate.key === view.key) ?? view;
    return { key: view.key, value: view.value, mixed: false, default: view.default,
      project_scoped: view.project_scoped, revision: JSON.stringify([project, view.value, global.value, view.source]),
      environment: global, members: project ? [{ project_id: project, name: project, view }] : [], overrides: [] };
  }) };
}
