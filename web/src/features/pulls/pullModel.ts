import type { PullListEntry } from "../../api/types";

export type PullSort = "updated" | "newest" | "oldest";

export interface PullFilters {
  draft: "all" | "only" | "hide";
  review: "all" | "approved" | "changes_requested" | "review_required" | "none";
  checks: "all" | "passing" | "failing";
  project: string | null;
  author: string | null;
  label: string | null;
}

export const noFilters: PullFilters = { draft: "all", review: "all", checks: "all", project: null, author: null, label: null };

/** Splits `label:x` out of the search, which the list filters on itself. */
export function parseSearch(text: string): { query: string; labels: string[] } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const labels = words.filter((word) => word.startsWith("label:")).map((word) => word.slice(6).toLowerCase());
  return { query: words.filter((word) => !word.startsWith("label:")).join(" "), labels };
}

/** The distinct values a list holds, for a filter to offer. */
export const authorsOf = (entries: readonly PullListEntry[]) =>
  [...new Set(entries.flatMap(({ pull }) => pull.author ?? []))].sort();
export const labelsOf = (entries: readonly PullListEntry[]) =>
  [...new Set(entries.flatMap(({ pull }) => pull.labels))].sort();

export function visiblePulls(
  entries: readonly PullListEntry[],
  filters: PullFilters,
  labels: readonly string[],
  sort: PullSort,
): PullListEntry[] {
  const kept = entries.filter(({ project_id, pull }) => {
    if (filters.project && project_id !== filters.project) return false;
    if (filters.draft === "only" && !pull.draft) return false;
    if (filters.draft === "hide" && pull.draft) return false;
    if (filters.review !== "all" && (pull.review_state ?? "none") !== filters.review) return false;
    if (filters.checks !== "all" && pull.checks_state !== filters.checks) return false;
    if (filters.author && pull.author !== filters.author) return false;
    const names = pull.labels.map((label) => label.toLowerCase());
    if (filters.label && !names.includes(filters.label.toLowerCase())) return false;
    return labels.every((label) => names.includes(label));
  });
  const stamp = (entry: PullListEntry) => entry.pull.updated_at ?? "";
  return [...kept].sort((a, b) =>
    sort === "updated"
      ? stamp(b).localeCompare(stamp(a))
      : sort === "newest"
        ? b.pull.number - a.pull.number
        : a.pull.number - b.pull.number,
  );
}
