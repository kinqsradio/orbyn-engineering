/** The unified update API. Provisional until generated types land, like workspace.ts. */
import type { IncomingCommit } from "./workspace";

export interface EngineUpdate {
  id: string;
  name: string;
  current: string | null;
  latest: string | null;
  available: boolean;
}

export interface LibraryUpdate {
  current: string;
  latest: string | null;
  available: boolean;
  modified: boolean;
  incoming: IncomingCommit[];
}

export interface AppUpdate {
  current: string;
  latest: string | null;
  available: boolean;
  /** Markdown release notes. */
  notes: string | null;
  /** Server and web installs update by hand; this says how. */
  manual_hint: string | null;
  can_apply: boolean;
}

export type UpdateStepState = "pending" | "running" | "done" | "failed";

export interface UpdateStep {
  id: string;
  label: string;
  state: UpdateStepState;
  error: string | null;
}

export interface UpdateStatus {
  /** False when this build has no update source. */
  configured: boolean;
  checked_at: string | null;
  checking: boolean;
  active_runs: number;
  engines: EngineUpdate[];
  library: LibraryUpdate | null;
  app: AppUpdate | null;
  /** The apply in progress or the one that stopped; null when idle. */
  progress: UpdateStep[] | null;
}
