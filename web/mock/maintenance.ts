/** Maintenance data shaped like the service's diagnostics and storage-cleanup responses. */
import type { CleanupReport, Diagnostics } from "../src/api/types.ts";

export function diagnostics(now: number): Diagnostics {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return {
    version: "0.42.1",
    pid: 4120,
    active_runs: 2,
    terminals: 1,
    database: { bytes: 41_000_000, reclaimable_bytes: 3_000_000, repair_suggested: false },
    processes: [
      { pid: 4120, parent: null, name: "orbynd", memory_bytes: 182_000_000, running_seconds: 5400 },
      { pid: 4188, parent: 4120, name: "claude", memory_bytes: 96_000_000, running_seconds: 1200 },
    ],
    history: [{ at: ago(2), memory_bytes: 176_000_000, processes: 2 }, { at: ago(1), memory_bytes: 182_000_000, processes: 2 }],
    events: [
      { at: ago(30), level: "WARN", target: "orbyn_core::engines", message: "Provider health check for Codex timed out after 10 s." },
      { at: ago(18 * 60), level: "ERROR", target: "orbyn_core::source_control", message: "Git fetch for orbyn-planner failed: network unreachable." },
    ],
  };
}

/** What a dry run would do: one entry per file or folder, kept or not. */
export function cleanupPreview(now: number): CleanupReport {
  const entries = [
    ...Array.from({ length: 3 }, (_, at) => ({ kind: "artifact", path: `/data/browser/shot-${at + 1}.png`, removed: false, reason: "Older than 14 days" })),
    { kind: "log", path: "/data/logs/orbynd.2026-10-20.log", removed: false, reason: "Older than 7 days" },
    { kind: "worktree", path: "/code/orbyn-engineering-wt/old-icon-picker", removed: false, reason: "Settled over 7 days ago" },
  ];
  return { dry_run: true, ran_at: new Date(now).toISOString(), entries };
}
