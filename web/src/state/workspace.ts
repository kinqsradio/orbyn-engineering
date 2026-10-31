import { create } from "zustand";
import { ApiFailure, api } from "../api/client";
import type { Approval, EngineStatus, Project, Thread } from "../api/types";
import type { UpdateStatus } from "../api/updates";
import type { WorkspaceStatus } from "../api/workspace";
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

  refreshManaged(): Promise<void>;
  refreshUpdates(): Promise<void>;
  putUpdates(status: UpdateStatus): void;
  putManaged(status: WorkspaceStatus): void;
  refreshProjects(): Promise<void>;
  refreshThreads(projectId: string): Promise<void>;
  refreshThread(id: string): Promise<void>;
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
      if (current()) {
        set((state) => ({
          projects: { data: state.projects.data, error: toFailure(error), loading: false },
        }));
      }
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
      if (current()) {
        set((state) => ({
          engines: { data: state.engines.data, error: toFailure(error), loading: false },
        }));
      }
    }
  },

  async refreshAll() {
    const { refreshProjects, refreshThreads, refreshApprovals, refreshManaged, refreshUpdates } = get();
    await refreshProjects();
    const projects = get().projects.data ?? [];
    await Promise.all([
      ...projects.map((p) => refreshThreads(p.id)),
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

/** The engine record for a thread, if the engine list has loaded. */
export const engineById = (engines: readonly EngineStatus[] | null, id: string) =>
  engines?.find((engine) => engine.id === id) ?? null;
