import { useEffect, useRef } from "react";
import { api, type ApiFailure } from "../../api/client";
import type { ResolvedThreadPath } from "../../generated/ResolvedThreadPath";
import type { ThreadPathBasis } from "../../generated/ThreadPathBasis";
import { toFailure, useAsync } from "../../lib/useAsync";
import { parseRoute } from "../../state/route";
import { useWorkspace } from "../../state/workspace";

interface Resolution {
  key: string;
  value: ResolvedThreadPath | null;
  error: ApiFailure | null;
}

/** Only the latest navigation in the same thread/cwd can consume these coordinates. */
export function useResolvedThreadPath(threadId: string, reference: { threadId: string; cwd: string; path: string; basis: ThreadPathBasis; nonce: number } | null) {
  const cwd = useWorkspace((state) => state.threads[threadId]?.cwd);
  const epoch = useRef(0);
  useEffect(() => {
    const cancel = () => { epoch.current += 1; };
    window.addEventListener("hashchange", cancel);
    return () => { cancel(); window.removeEventListener("hashchange", cancel); };
  }, [threadId]);
  const key = JSON.stringify([threadId, cwd, reference]);
  const result = useAsync(key, async (signal): Promise<Resolution> => {
    if (!reference || !cwd || reference.threadId !== threadId || reference.cwd !== cwd) return { key, value: null, error: null };
    const observed = epoch.current;
    const hash = window.location.hash;
    const current = () => {
      const route = parseRoute(window.location.hash);
      return observed === epoch.current && hash === window.location.hash && route.name === "thread"
        && route.id === threadId && useWorkspace.getState().threads[threadId]?.cwd === cwd;
    };
    try {
      const value = await api.resolveThreadPath(threadId, { path: reference.path, basis: reference.basis, cwd }, signal);
      if (!current() || value.cwd !== cwd) throw new DOMException("Navigation changed", "AbortError");
      return { key, value, error: null };
    } catch (error) {
      if (!current() || (error instanceof DOMException && error.name === "AbortError")) throw new DOMException("Navigation changed", "AbortError");
      return { key, value: null, error: toFailure(error) };
    }
  });
  // useAsync retains prior data during refresh; it must not identify a new click.
  return result.data?.key === key ? result.data : { key, value: null, error: null };
}
