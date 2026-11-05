import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type ApiFailure } from "../../api/client";
import type { UsageReport } from "../../api/types";
import { toFailure } from "../../lib/useAsync";
import type { UsageDays } from "./usageModel";

interface ReportState {
  scope: { days: UsageDays };
  data: UsageReport | null;
  pending: boolean;
  error: ApiFailure | null;
}

/** A refresh can retain only this period's report. POST is not abortable, so
 * generations fence its result independently of GET cancellation. */
export function useUsageReport(days: UsageDays) {
  const scope = useMemo(() => ({ days }), [days]);
  const [state, setState] = useState<ReportState>({ scope, data: null, pending: true, error: null });
  const activeScope = useRef<typeof scope | null>(scope);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      activeScope.current = null;
      generation.current += 1;
      controller.current?.abort();
    };
  }, [scope]);

  const load = useCallback(async (force: boolean) => {
    if (activeScope.current !== scope) return;
    const id = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState((previous) => ({
      scope, data: previous.scope === scope ? previous.data : null, pending: true, error: null,
    }));
    try {
      const data = await (force ? api.refreshUsage(scope.days) : api.usage(scope.days, abort.signal));
      if (generation.current === id) setState({ scope, data, pending: false, error: null });
    } catch (failure) {
      if (generation.current !== id) return;
      setState((previous) => ({ ...previous, pending: false, error: toFailure(failure) }));
    }
  }, [scope]);

  useEffect(() => { void load(false); }, [load]);

  // Resource identity changes during render; an old period is never shown even
  // in the interval before the new request's effect starts.
  const current = state.scope === scope ? state : { scope, data: null, pending: true, error: null };
  return {
    ...current,
    reload: () => load(false),
    refresh: () => load(true),
  };
}
