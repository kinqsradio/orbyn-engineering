/**
 * The managed workspace API. Provisional: `crates/orbyn-contracts` has no types
 * for these routes yet, so this file is the one place to replace with the
 * generated types when they land.
 */
import type { Project } from "./types";

export interface IncomingCommit {
  revision: string;
  subject: string;
}

export interface LibraryStatus {
  path: string;
  revision: string;
  branch: string;
  modified: boolean;
  ahead: number;
  behind: number;
  /** Commits Update would bring in, newest first. */
  incoming: IncomingCommit[];
  /** The revision Roll back returns to; null when there's nothing to return to. */
  previous_revision: string | null;
}

export interface WorkspaceWorktree {
  path: string;
  branch: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  git_root: string;
  revision: string | null;
  branch: string | null;
  modified: boolean;
  unpushed: boolean;
  worktrees: WorkspaceWorktree[];
  /** Skills in this repository that share a name with a library skill. */
  overlaps: string[];
}

export type WorkspaceState = "unset" | "setting_up" | "ready" | "failed";

export interface WorkspaceStatus {
  state: WorkspaceState;
  /** The step in progress while setting up. */
  step: string | null;
  error: string | null;
  library: LibraryStatus | null;
  projects: WorkspaceProject[];
  active_runs: number;
  /** `fallback` when skill links couldn't be created, as can happen on Windows. */
  skill_delivery: "linked" | "fallback";
}

export type WorkspaceSetup = { mode: "managed" } | { mode: "adopt"; path: string };

export interface ImportPreview {
  path: string;
  git_root: string | null;
  branch: string | null;
  uncommitted: string[];
  unpushed_branches: string[];
}

export interface ImportResult {
  project: Project;
}
