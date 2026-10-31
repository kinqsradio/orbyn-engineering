import { useMemo } from "react";
import { create } from "zustand";
import { ApiFailure, api } from "../api/client";
import type {
  ApplyAllResult,
  Approval,
  EngineStatus,
  Project,
  Thread,
  UpdateStatus,
  WorkspaceStatus,
} from "../api/types";
import { toFailure } from "../lib/useAsync";

export interface Loadable<T> {
  data: T | null;
  error: ApiFailure | null;
  loading: boolean;
}

const idle = <T>(): Loadable<T> => ({ data: null, error: null, loading: false });

interface WorkspaceState {
  projects: Loadable<Project[]>;
  /** Thread ids per project, in server order. */
  threadIds: Record<string, Loadable<string[]>>;
  threads: Record<string, Thread>;
  missingThreads: Record<string, ApiFailure>;
  approvals: Loadable<Approval[]>;
  /** Decisions this client received, so a card shows its outcome at once. */
  receipts: Record<string, Approval>;
  engines: Loadable<EngineStatus[]>;
  managed: Loadable<WorkspaceStatus>;
  /** The service predates the workspace API, so there's nothing to set up. */
  managedUnsupported: boolean;
  updates: Loadable<UpdateStatus>;
  updatesUnsupported: boolean;
  /** The Update all in progress, or the one that stopped. */
  updateRun: UpdateRun | null;

  runAllUpdates(): Promise<void>;
  refreshManaged(): Promise<void>;
  refreshUpdates(): Promise<void>;
  putUpdates(status: UpdateStatus): void;
  putManaged(status: WorkspaceStatus): void;
  refreshProjects(): Promise<void>;
  refreshThreads(projectId: string): Promise<void>;
  refreshThread(id: string): Promise<void>;
  /** Scratch threads sit behind hidden projects, which project lists leave out. */
  refreshScratch(): Promise<void>;
  refreshApprovals(): Promise<void>;
  refreshEngines(): Promise<void>;
  refreshAll(): Promise<void>;
  putProject(project: Project): void;
  dropProject(projectId: string): void;
  putThread(thread: Thread): void;
  dropThread(thread: Thread): void;
  putReceipt(approval: Approval): void;
}

/** Newest-request-wins per resource key. */
const generations = new Map<string, number>();
const claim = (key: string) => {
  const next = (generations.get(key) ?? 0) + 1;
  generations.set(key, next);
  return () => generations.get(key) === next;
};

export type UpdateStepState = "pending" | "running" | "done" | "failed";

export interface UpdateRunStep {
  target: string;
  label: string;
  state: UpdateStepState;
  error: string | null;
}

export interface UpdateRun {
  running: boolean;
  steps: UpdateRunStep[];
  error: string | null;
}

const PROGRESS_POLL_MS = 1000;
/** Nothing to list yet, which the quiet notice explains; not a failure to show on every surface. */
const LIBRARY_MISSING = "workspace_required";

export const engineHasUpdate = (engine: UpdateStatus["engines"][number]) =>
  engine.latest !== null && engine.latest !== engine.current;
export const appHasUpdate = (status: UpdateStatus) =>
  status.app.latest !== null && status.app.latest !== status.app.current;

/** What Update all will run, in the server's order. */
export function plannedSteps(status: UpdateStatus, engines: readonly EngineStatus[]): UpdateRunStep[] {
  const step = (target: string, label: string): UpdateRunStep => ({
    target,
    label,
    state: "pending",
    error: null,
  });
  const planned = [
    ...status.engines
      .filter((engine) => engineHasUpdate(engine) && engine.can_apply)
      .map((engine) =>
        step(`engine:${engine.id}`, engines.find((e) => e.id === engine.id)?.name ?? engine.id),
      ),
    ...(status.library.behind > 0 ? [step("library", "Skills library")] : []),
    ...(appHasUpdate(status) && status.app.can_apply ? [step("app", "App")] : []),
  ];
  return planned.map((entry, at) => (at === 0 ? { ...entry, state: "running" } : entry));
}

const stillAvailable = (target: string, status: UpdateStatus) => {
  if (target === "library") return status.library.behind > 0;
  if (target === "app") return appHasUpdate(status);
  const engine = status.engines.find((e) => `engine:${e.id}` === target);
  return engine ? engineHasUpdate(engine) : false;
};

/** Live progress from the status the server reports while it applies. */
export function advanceSteps(steps: UpdateRunStep[], status: UpdateStatus): UpdateRunStep[] {
  const done = steps.map((step) =>
    stillAvailable(step.target, status) ? step : { ...step, state: "done" as const },
  );
  const next = done.findIndex((step) => step.state !== "done");
  return done.map((step, at) =>
    at === next ? { ...step, state: "running" } : step.state === "done" ? step : { ...step, state: "pending" },
  );
}

export function settleSteps(planned: UpdateRunStep[], result: ApplyAllResult): UpdateRunStep[] {
  return planned.map((step) => {
    const ran = result.steps.find((entry) => entry.target === step.target);
    if (!ran) return { ...step, state: "pending" };
    return ran.ok
      ? { ...step, state: "done" }
      : { ...step, state: "failed", error: ran.message };
  });
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  projects: idle(),
  threadIds: {},
  threads: {},
  missingThreads: {},
  approvals: idle(),
  receipts: {},
  engines: idle(),
  managed: idle(),
  managedUnsupported: false,
  updates: idle(),
  updatesUnsupported: false,
  updateRun: null,

  async runAllUpdates() {
    const { updates, engines, updateRun } = get();
    if (!updates.data || updateRun?.running) return;
    const planned = plannedSteps(updates.data, engines.data ?? []);
    set({ updateRun: { running: true, steps: planned, error: null } });
    const poll = setInterval(() => {
      void get()
        .refreshUpdates()
        .then(() => {
          const status = get().updates.data;
          const run = get().updateRun;
          if (status && run?.running) {
            set({ updateRun: { ...run, steps: advanceSteps(run.steps, status) } });
          }
        });
    }, PROGRESS_POLL_MS);
    try {
      const result = await api.applyAllUpdates();
      const failed = result.steps.find((step) => !step.ok);
      const steps = settleSteps(planned, result);
      set({ updateRun: failed ? { running: false, steps, error: null } : null });
    } catch (error) {
      set({
        updateRun: {
          running: false,
          steps: planned.map((step) => ({ ...step, state: "pending" })),
          error: toFailure(error).message,
        },
      });
    } finally {
      clearInterval(poll);
      const { refreshUpdates, refreshEngines, refreshManaged } = get();
      await Promise.all([refreshUpdates(), refreshEngines(), refreshManaged()]);
    }
  },

  async refreshUpdates() {
    const current = claim("updates");
    try {
      const data = await api.updates();
      if (current()) set({ updates: { data, error: null, loading: false } });
    } catch (error) {
      if (!current()) return;
      const failure = toFailure(error);
      set((state) => ({
        updates: { data: state.updates.data, error: failure, loading: false },
        updatesUnsupported: failure.status === 404,
      }));
    }
  },

  putUpdates(status) {
    claim("updates");
    set({ updates: { data: status, error: null, loading: false } });
  },

  async refreshManaged() {
    const current = claim("managed");
    set((state) => ({ managed: { ...state.managed, loading: true } }));
    try {
      const data = await api.workspace();
      if (current()) set({ managed: { data, error: null, loading: false } });
    } catch (error) {
      if (!current()) return;
      const failure = toFailure(error);
      set((state) => ({
        managed: { data: state.managed.data, error: failure, loading: false },
        managedUnsupported: failure.status === 404,
      }));
    }
  },

  putManaged(status) {
    claim("managed");
    set({ managed: { data: status, error: null, loading: false } });
  },

  async refreshProjects() {
    const current = claim("projects");
    set((state) => ({ projects: { ...state.projects, loading: true } }));
    try {
      const data = await api.projects();
      if (current()) set({ projects: { data, error: null, loading: false } });
    } catch (error) {
      if (!current()) return;
      const failure = toFailure(error);
      if (failure.code === LIBRARY_MISSING) set({ projects: { data: [], error: null, loading: false } });
      else set((state) => ({ projects: { data: state.projects.data, error: failure, loading: false } }));
    }
  },

  async refreshThreads(projectId) {
    const current = claim(`threads:${projectId}`);
    set((state) => ({
      threadIds: {
        ...state.threadIds,
        [projectId]: { ...(state.threadIds[projectId] ?? idle()), loading: true },
      },
    }));
    try {
      const list = await api.threads(projectId);
      if (!current()) return;
      set((state) => ({
        threadIds: {
          ...state.threadIds,
          [projectId]: { data: list.map((t) => t.id), error: null, loading: false },
        },
        threads: { ...state.threads, ...Object.fromEntries(list.map((t) => [t.id, t])) },
      }));
    } catch (error) {
      if (!current()) return;
      set((state) => ({
        threadIds: {
          ...state.threadIds,
          [projectId]: {
            data: state.threadIds[projectId]?.data ?? null,
            error: toFailure(error),
            loading: false,
          },
        },
      }));
    }
  },

  async refreshScratch() {
    const current = claim("scratch");
    try {
      const list = (await api.allThreads()).filter((thread) => thread.scratch);
      if (!current()) return;
      set((state) => ({
        threads: { ...state.threads, ...Object.fromEntries(list.map((t) => [t.id, t])) },
      }));
    } catch {
      // Project threads still load; the next poll tries again.
    }
  },

  async refreshThread(id) {
    const current = claim(`thread:${id}`);
    try {
      const thread = await api.thread(id);
      if (!current()) return;
      set((state) => {
        const { [id]: _gone, ...missing } = state.missingThreads;
        return { threads: { ...state.threads, [id]: thread }, missingThreads: missing };
      });
    } catch (error) {
      if (current()) {
        set((state) => ({
          missingThreads: { ...state.missingThreads, [id]: toFailure(error) },
        }));
      }
    }
  },

  async refreshApprovals() {
    const current = claim("approvals");
    set((state) => ({ approvals: { ...state.approvals, loading: true } }));
    try {
      const data = await api.pendingApprovals();
      if (current()) set({ approvals: { data, error: null, loading: false } });
    } catch (error) {
      if (current()) {
        set((state) => ({
          approvals: { data: state.approvals.data, error: toFailure(error), loading: false },
        }));
      }
    }
  },

  async refreshEngines() {
    const current = claim("engines");
    set((state) => ({ engines: { ...state.engines, loading: true } }));
    try {
      const data = await api.engines();
      if (current()) set({ engines: { data, error: null, loading: false } });
    } catch (error) {
      if (!current()) return;
      const failure = toFailure(error);
      if (failure.code === LIBRARY_MISSING) set({ engines: { data: [], error: null, loading: false } });
      else set((state) => ({ engines: { data: state.engines.data, error: failure, loading: false } }));
    }
  },

  async refreshAll() {
    const { refreshProjects, refreshThreads, refreshApprovals, refreshManaged, refreshUpdates } = get();
    await refreshProjects();
    const projects = get().projects.data ?? [];
    await Promise.all([
      ...projects.map((p) => refreshThreads(p.id)),
      get().refreshScratch(),
      refreshApprovals(),
      refreshManaged(),
      refreshUpdates(),
    ]);
  },

  putProject(project) {
    set((state) => {
      const list = state.projects.data ?? [];
      const known = list.some((p) => p.id === project.id);
      return {
        projects: {
          ...state.projects,
          data: known ? list.map((p) => (p.id === project.id ? project : p)) : [...list, project],
        },
      };
    });
  },

  dropProject(projectId) {
    set((state) => {
      const { [projectId]: _gone, ...threadIds } = state.threadIds;
      return {
        projects: {
          ...state.projects,
          data: (state.projects.data ?? []).filter((p) => p.id !== projectId),
        },
        threadIds,
        threads: Object.fromEntries(
          Object.entries(state.threads).filter(([, thread]) => thread.project_id !== projectId),
        ),
      };
    });
  },

  putThread(thread) {
    set((state) => {
      const known = state.threadIds[thread.project_id] ?? idle<string[]>();
      const ids = known.data ?? [];
      return {
        threads: { ...state.threads, [thread.id]: thread },
        threadIds: {
          ...state.threadIds,
          [thread.project_id]: {
            ...known,
            data: ids.includes(thread.id) ? ids : [thread.id, ...ids],
          },
        },
      };
    });
  },

  dropThread(thread) {
    set((state) => {
      const { [thread.id]: _gone, ...threads } = state.threads;
      const known = state.threadIds[thread.project_id];
      return {
        threads,
        threadIds: known
          ? {
              ...state.threadIds,
              [thread.project_id]: {
                ...known,
                data: (known.data ?? []).filter((id) => id !== thread.id),
              },
            }
          : state.threadIds,
      };
    });
  },

  putReceipt(approval) {
    set((state) => ({
      receipts: { ...state.receipts, [approval.id]: approval },
      approvals: {
        ...state.approvals,
        data: (state.approvals.data ?? []).filter((a) => a.id !== approval.id),
      },
    }));
  },
}));

/** Projects as the person sees them: the skills library stays out of project flows. */
export function useVisibleProjects(): Project[] | null {
  const projects = useWorkspace((state) => state.projects.data);
  const library = useWorkspace((state) => state.managed.data?.library?.path);
  return useMemo(
    () => projects?.filter((project) => project.path !== library && !project.scratch) ?? null,
    [projects, library],
  );
}

/** The engine record for a thread, if the engine list has loaded. */
export const engineById = (engines: readonly EngineStatus[] | null, id: string) =>
  engines?.find((engine) => engine.id === id) ?? null;
