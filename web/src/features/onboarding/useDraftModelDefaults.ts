import { useEffect, useState } from "react";
import { request } from "../../api/client";
import type { EngineStatus, PreferenceView } from "../../api/types";
import { useUi } from "../../state/ui";
import { toFailure } from "../../lib/useAsync";
import { chooseDraftEngine } from "../../lib/draftEngine";

type Choice = { engine: string; model: string | null; effort: string | null };
type Defaults = { engine: string; model: string; effort: string; disabled: string[] };

function readDefaults(views: PreferenceView[]): Defaults {
  const engine = views.find((view) => view.key === "default_engine")?.value;
  const model = views.find((view) => view.key === "default_model")?.value;
  // An older service has no default effort; that reads as the model's own default.
  const effort = views.find((view) => view.key === "default_effort")?.value ?? "";
  const disabled = views.find((view) => view.key === "disabled_engines")?.value;
  if (typeof engine !== "string" || typeof model !== "string" || typeof effort !== "string" || !Array.isArray(disabled)
    || !disabled.every((value) => typeof value === "string")) {
    throw new Error("Model defaults are unavailable.");
  }
  return { engine, model, effort, disabled };
}

/** A default read and an explicit choice each belong to one physical draft project. */
export function useDraftModelDefaults(projectId: string | null, engines: EngineStatus[] | null,
  remembered: Choice | null) {
  const [loaded, setLoaded] = useState<{ scope: string | null; defaults: Defaults | null; error: string | null } | null>(null);
  const [picked, setPicked] = useState<{ scope: string | null; choice: Choice } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Settings stays open over a mounted draft, so a saved default must be read again.
  const revision = useUi((state) => state.preferencesRevision);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    const path = projectId === null ? "/api/preferences" : `/api/preferences?project_id=${encodeURIComponent(projectId)}`;
    request<PreferenceView[]>("GET", path, undefined, controller.signal).then((views) => {
      if (!controller.signal.aborted) setLoaded({ scope: projectId, defaults: readDefaults(views), error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ scope: projectId, defaults: null,
        error: error instanceof Error && !("code" in error) ? error.message : toFailure(error).message });
    });
    return () => controller.abort();
  }, [projectId, attempt, revision]);
  const current = loaded?.scope === projectId ? loaded : null;
  const defaults = current?.defaults;
  const explicit = picked?.scope === projectId ? picked.choice : null;
  const installed = (engines ?? []).filter((engine) => engine.installed && !defaults?.disabled.includes(engine.id));
  // A configured provider is deliberate. Its disappearance must not select another provider.
  const wanted = explicit?.engine ?? (defaults?.engine || remembered?.engine || null);
  const deliberate = explicit !== null || !!defaults?.engine;
  const engine = deliberate ? installed.find((entry) => entry.id === wanted) ?? null
    : chooseDraftEngine(installed, wanted, false);
  const model = explicit ? explicit.model
    : defaults?.model ? defaults.model : remembered && remembered.engine === engine?.id ? remembered.model : null;
  // The project's default effort belongs to its default model and wins over what was last chosen with it.
  const defaultEffort = defaults?.model && model === defaults.model && defaults.effort ? defaults.effort : null;
  const effort = explicit ? explicit.effort
    : defaultEffort ?? (remembered && remembered.engine === engine?.id && remembered.model === model ? remembered.effort : null);
  return {
    installed, engine, model, effort, explicit: explicit !== null,
    loading: current === null,
    error: current?.error ?? (current && deliberate && !engine ? "The selected default provider is unavailable for this project. Choose another model." : null),
    choose: (choice: Choice) => setPicked({ scope: projectId, choice }),
    reload: () => setAttempt((value) => value + 1),
  };
}
