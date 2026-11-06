import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ScopedPreferencesChange } from "../../generated/ScopedPreferencesChange";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";

export const MODEL_DEFAULT_KEYS = ["default_engine", "default_model"] as const;
export type DefaultModelChoice = { engine: string; model: string | null };

export function modelDefaultChange(result: ScopedPreferencesResult, scope: ProjectScopesQuery,
  choice: DefaultModelChoice | "inherit" | { reset: string[] }): ScopedPreferencesChange {
  const edits: Record<string, PreferenceEdit> = {};
  const if_match: Record<string, string> = {};
  for (const key of MODEL_DEFAULT_KEYS) {
    const row = result.rows.find((entry) => entry.key === key);
    if (!row) throw new Error("Model defaults are unavailable.");
    if_match[key] = row.revision;
    edits[key] = choice === "inherit" ? { op: "inherit" }
      : "reset" in choice ? { op: "reset_overrides", project_ids: choice.reset }
      : { op: "set", value: key === "default_engine" ? choice.engine : choice.model ?? "" };
  }
  return { scope, membership_version: result.catalog.version, if_match, edits };
}
