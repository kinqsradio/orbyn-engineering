import { useEffect, useState } from "react";
import { request } from "../../api/client";
import type { PreferenceView, Project } from "../../api/types";
import { toFailure } from "../../lib/useAsync";

/** Defaults belong to the selected physical checkout; explicit draft picks win. */
export function useDraftCheckout(project: Pick<Project, "id" | "is_git"> | null, reused: string | null) {
  const scope = project?.id ?? null;
  const git = project?.is_git === true;
  const [picked, setPicked] = useState<{ scope: string | null; value: string | null } | null>(null);
  const [loaded, setLoaded] = useState<{ scope: string; value: string | null; error: string | null } | null>(null);
  useEffect(() => {
    if (reused !== null) setPicked({ scope, value: reused });
  }, [reused, scope]);
  useEffect(() => {
    if (!scope || !git) return;
    const controller = new AbortController();
    request<PreferenceView[]>("GET", `/api/preferences?project_id=${encodeURIComponent(scope)}`, undefined, controller.signal)
      .then((views) => {
        if (controller.signal.aborted) return;
        const value = views.find((view) => view.key === "default_thread_env_mode")?.value;
        if (value !== "local" && value !== "worktree") throw new Error("The checkout default is unavailable.");
        setLoaded({ scope, value: value === "worktree" ? "" : null, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoaded({ scope, value: null, error: toFailure(error).message });
      });
    return () => controller.abort();
  }, [scope, git]);
  const explicit = picked?.scope === scope;
  const current = loaded?.scope === scope ? loaded : null;
  const worktree = !git ? null : explicit ? picked.value : reused ?? current?.value ?? null;
  return {
    worktree,
    setWorktree: (value: string | null) => setPicked({ scope, value }),
    loading: git && !explicit && reused === null && current === null,
    error: git && !explicit && reused === null ? current?.error ?? null : null,
  };
}
