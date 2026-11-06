import type { ScopedPreferencesResult } from "../../generated/ScopedPreferencesResult";
import type { ScopedPreferencesChange } from "../../generated/ScopedPreferencesChange";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";

/** One tuple: effort and options belong to the default model, so all four move together. */
export const MODEL_DEFAULT_KEYS = ["default_engine", "default_model", "default_effort", "default_model_options"] as const;
export type DefaultModelChoice = {
  engine: string;
  model: string | null;
  /** Null leaves the model's own default effort. */
  effort?: string | null;
  /** Option id to value, without effort. Empty leaves the model's own defaults. */
  options?: Record<string, string>;
};

const valueOf = (key: (typeof MODEL_DEFAULT_KEYS)[number], choice: DefaultModelChoice) =>
  key === "default_engine" ? choice.engine
    : key === "default_model" ? choice.model ?? ""
    : key === "default_effort" ? choice.effort ?? ""
    : choice.options ?? {};

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
      : { op: "set", value: valueOf(key, choice) };
  }
  return { scope, membership_version: result.catalog.version, if_match, edits };
}
