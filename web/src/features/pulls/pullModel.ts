import type { PullListEntry } from "../../api/types";

export type PullState = "open" | "closed" | "merged";
export type ReviewKey = "approved" | "changes_requested" | "review_required";
export type CheckKey = "passing" | "failing" | "running";

/** What the list orders by, and which end comes first. */
export interface PullSort {
  by: "updated" | "created" | "comments";
  dir: "newest" | "oldest";
}

export interface PullFilters {
  /** Which states to list. The service answers one state at a time, so each is asked for on its own. */
  states: PullState[];
  draft: "all" | "only" | "hide";
  review: ReviewKey[];
  checks: CheckKey[];
  project: string | null;
  author: string | null;
  /** Only pull requests by one of the signed-in accounts. */
  me: boolean;
  labels: string[];
}

/**
 * What the forge contract does not carry yet. Each flag turns one hidden control back on, in the
 * place the design draws it, once its field arrives. All false for now.
 */
export interface PullData {
  /** Who is asked to review: the "Needs my review" filter. */
  reviewRequests: boolean;
  /** The signed-in person's login: the Author "Me" choice. */
  viewerLogin: boolean;
  /** A comment count: the "Most comments" sort. */
  commentCount: boolean;
  /** A creation time: Created and Oldest across several repositories. */
  createdAt: boolean;
}
export const pullData: PullData = { reviewRequests: false, viewerLogin: false, commentCount: false, createdAt: false };

export const defaultSort: PullSort = { by: "updated", dir: "newest" };

/** The service says `pass` and `fail`; older stand-ins say `passing` and `failing`. */
export const checksOf = (state: string | null): "pass" | "fail" | "pending" | "none" =>
  state === "pass" || state === "passing" ? "pass" : state === "fail" || state === "failing" ? "fail" : state === "pending" ? "pending" : "none";

export const noFilters: PullFilters = {
  states: ["open"],
  draft: "all",
  review: [],
  checks: [],
  project: null,
  author: null,
  me: false,
  labels: [],
};

/** Splits `label:x` out of the search, which the list filters on itself. */
export function parseSearch(text: string): { query: string; labels: string[] } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const labels = words.filter((word) => word.length > 6 && word.startsWith("label:")).map((word) => word.slice(6).toLowerCase());
  return { query: words.filter((word) => !(word.length > 6 && word.startsWith("label:"))).join(" "), labels };
}

/**
 * Pulls finished `label:x` words out of what is being typed. A word is finished once a space
 * follows it, or when `final` says the text is being submitted or left.
 */
export function takeLabels(value: string, final: boolean): { labels: string[]; rest: string } {
  const labels: string[] = [];
  const rest = value
    .replace(final ? /(^|\s)label:(\S+)(?=\s|$)/gi : /(^|\s)label:(\S+)(?=\s)/gi, (_, lead: string, name: string) => {
      labels.push(name.toLowerCase());
      return lead;
    })
    .replace(/\s{2,}/g, " ")
    .replace(/^\s+/, "");
  return { labels, rest: final ? rest.trim() : rest };
}

/** The distinct values a list holds, for a filter to offer. */
export const authorsOf = (entries: readonly PullListEntry[]) =>
  [...new Set(entries.flatMap(({ pull }) => pull.author ?? []))].sort();
export const labelsOf = (entries: readonly PullListEntry[]) =>
  [...new Set(entries.flatMap(({ pull }) => pull.labels))].sort();

const REVIEW_LABELS: Record<ReviewKey, string> = {
  review_required: "review required",
  approved: "approved",
  changes_requested: "changes requested",
};

/** One removable chip per filter that is on. Open, drafts included and anyone are the defaults and never count. */
export interface FilterChip {
  id: string;
  label: string;
  remove(filters: PullFilters): PullFilters;
}

export function activeChips(filters: PullFilters): FilterChip[] {
  const chips: FilterChip[] = [];
  const isDefaultState = filters.states.length === 1 && filters.states[0] === "open";
  if (!isDefaultState) {
    for (const state of filters.states) {
      chips.push({
        id: `state:${state}`,
        label: `State: ${state}`,
        remove: (f) => {
          const states = f.states.filter((one) => one !== state);
          return { ...f, states: states.length > 0 ? states : ["open"] };
        },
      });
    }
  }
  if (filters.draft !== "all") {
    chips.push({ id: "draft", label: `Draft: ${filters.draft === "hide" ? "exclude" : "only"}`, remove: (f) => ({ ...f, draft: "all" }) });
  }
  for (const key of filters.review) {
    chips.push({ id: `review:${key}`, label: `Review: ${REVIEW_LABELS[key]}`, remove: (f) => ({ ...f, review: f.review.filter((one) => one !== key) }) });
  }
  for (const key of filters.checks) {
    chips.push({ id: `checks:${key}`, label: `Checks: ${key}`, remove: (f) => ({ ...f, checks: f.checks.filter((one) => one !== key) }) });
  }
  if (filters.me) chips.push({ id: "author:me", label: "Author: me", remove: (f) => ({ ...f, me: false }) });
  if (filters.author) chips.push({ id: "author", label: `Author: ${filters.author}`, remove: (f) => ({ ...f, author: null }) });
  for (const name of filters.labels) {
    chips.push({ id: `label:${name}`, label: `Label: ${name}`, remove: (f) => ({ ...f, labels: f.labels.filter((one) => one !== name) }) });
  }
  return chips;
}

/** Every filter back to its default. The project is its own control and stays. */
export const clearedFilters = (filters: PullFilters): PullFilters => ({ ...noFilters, project: filters.project });

/** The service state words to ask for: all three at once is the service's `all`. */
export const statesToAsk = (states: readonly PullState[]): string[] => (states.length === 3 ? ["all"] : [...states]);

/** `Updated`, `Created` or `Oldest`: the sort as the button names it. */
export const sortName = (sort: PullSort) =>
  sort.by === "updated" ? "Updated" : sort.by === "comments" ? "Most comments" : sort.dir === "oldest" ? "Oldest" : "Created";

/** The contract carries no comment count yet, so every pull request counts the same. */
const commentsOf = (_entry: PullListEntry) => 0;

export function visiblePulls(
  entries: readonly PullListEntry[],
  filters: PullFilters,
  labels: readonly string[],
  sort: PullSort,
  /** The signed-in person's login, once the contract carries it. */
  viewer: string | null = null,
): PullListEntry[] {
  const kept = entries.filter(({ project_id, pull }) => {
    if (filters.project && project_id !== filters.project) return false;
    if (filters.draft === "only" && !pull.draft) return false;
    if (filters.draft === "hide" && pull.draft) return false;
    if (filters.review.length > 0 && !filters.review.includes((pull.review_state ?? "none") as ReviewKey)) return false;
    if (filters.checks.length > 0) {
      const word = checksOf(pull.checks_state);
      const key = word === "pass" ? "passing" : word === "fail" ? "failing" : word === "pending" ? "running" : null;
      if (!key || !filters.checks.includes(key)) return false;
    }
    if (filters.me && !(viewer && pull.author === viewer)) return false;
    if (filters.author && pull.author !== filters.author) return false;
    const names = pull.labels.map((label) => label.toLowerCase());
    if (!filters.labels.every((label) => names.includes(label.toLowerCase()))) return false;
    return labels.every((label) => names.includes(label));
  });
  // The forge reports no creation time, so the number stands in for it (one repository only).
  const key = (entry: PullListEntry) =>
    sort.by === "updated"
      ? (entry.pull.updated_at ?? "")
      : sort.by === "comments"
        ? String(commentsOf(entry)).padStart(12, "0")
        : String(entry.pull.number).padStart(12, "0");
  const order = sort.dir === "newest" ? -1 : 1;
  return [...kept].sort((a, b) => order * key(a).localeCompare(key(b)));
}
