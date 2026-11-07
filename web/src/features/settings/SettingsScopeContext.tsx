import { createContext, useCallback, useContext, type ReactNode } from "react";
import { request, type ApiFailure } from "../../api/client";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import type { ProjectSettingsSelection } from "../../generated/ProjectSettingsSelection";
import { useAsync, toFailure } from "../../lib/useAsync";
import { navigate, useRoute, type SettingsSection } from "../../state/route";

// Device pages deliberately edit this client's/environment's defaults.
export const DEVICE_SETTINGS_SECTIONS: ReadonlySet<SettingsSection> = new Set([
  "general", "appearance", "chat", "about",
]);

/** Pages that show the scope line under the title (Applying settings for a project on a device). */
export const SCOPE_LINE_SECTIONS: ReadonlySet<SettingsSection> = new Set(["diffs", "providers", "threads", "worktrees", "projects", "source-control"]);
/** Pages that hold project-scoped keys; a row shows where its value comes from only when the service scopes its key per project. */
export const INHERITANCE_SECTIONS: ReadonlySet<SettingsSection> = new Set(["diffs", "providers", "threads", "worktrees", "projects", "source-control"]);

export interface SettingsScopeContextValue {
  inheritance: boolean;
  query: ProjectScopesQuery;
  catalog: ProjectScopeCatalog | null;
  loading: boolean;
  error: ApiFailure | null;
  active: boolean;
  select(next: ProjectSettingsSelection | undefined): void;
  reload(): void;
}

const SettingsScopeContext = createContext<SettingsScopeContextValue | null>(null);

export function SettingsScopeProvider({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const route = useRoute();
  const active = !DEVICE_SETTINGS_SECTIONS.has(section);
  const selection = route.name !== "settings" ? undefined : route.machine !== undefined
    // This app has no remote axis. Preserve its URL, but make scoped writes unavailable.
    ? { kind: "project_group" as const, group_key: `unavailable:machine:${route.machine}` } : route.selection;
  const query: ProjectScopesQuery = active && selection ? { selection } : {};
  const key = JSON.stringify(query);
  const result = useAsync(`settings-scope:${key}`, async (signal) => {
    try {
      return { key, catalog: await request<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", query, signal), error: null };
    } catch (error) {
      return { key, catalog: null, error: toFailure(error) };
    }
  });
  // Never expose the preceding selection while its replacement request starts.
  const current = result.data?.key === key;
  const select = useCallback((next: ProjectSettingsSelection | undefined) => {
    navigate({ name: "settings", section, selection: next, machine: undefined });
  }, [section]);
  const value: SettingsScopeContextValue = {
    inheritance: INHERITANCE_SECTIONS.has(section),
    query,
    catalog: current ? result.data!.catalog : null,
    loading: !current || result.refreshing,
    error: current ? result.data!.error : null,
    active,
    select,
    reload: result.reload,
  };
  return <SettingsScopeContext.Provider value={value}>{children}</SettingsScopeContext.Provider>;
}

/** Null keeps existing standalone project dialogs under their explicit project owner. */
export function useSettingsScope(): SettingsScopeContextValue | null {
  return useContext(SettingsScopeContext);
}
