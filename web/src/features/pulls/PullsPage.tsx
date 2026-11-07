import { Check, CircleCheck, CircleDot, CircleX, GitMerge, GitPullRequest, RefreshCw, Search, X } from "lucide-react";
import "./pulls.css";
import { useEffect, useMemo, useState } from "react";
import type { PullList, PullListEntry } from "../../api/types";
import { compactAge, relativeTime } from "../../lib/format";
import { useWaited } from "../../lib/motion";
import { deriveProjectIdentity } from "../../lib/projectIdentity";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useLayoutWidth } from "../../lib/useLayout";
import { navigate, useRoute } from "../../state/route";
import { useUi } from "../../state/ui";
import { useVisibleProjects } from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { PageBar } from "../../ui/PageBar";
import { ErrorState } from "../../ui/states";
import { PullDetail } from "./PullDetail";
import { PullsToolbar } from "./PullsToolbar";
import {
  activeChips,
  checksOf,
  clearedFilters,
  defaultSort,
  labelsOf,
  noFilters,
  pullData,
  statesToAsk,
  visiblePulls,
  authorsOf,
  type PullFilters,
  type PullSort,
} from "./pullModel";
import { pullsApi } from "../../api/pulls";
const CHECKS = { pass: "Passing", fail: "Failing", pending: "Running", none: "No checks" } as const;
const REVIEWS: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
  none: "",
};

/** One request per state the service is asked for, merged into one list. */
async function loadPulls(states: readonly string[], query: string, signal: AbortSignal): Promise<PullList> {
  const lists = await Promise.all(states.map((state) => pullsApi.list(state, query, signal)));
  const seen = new Set<string>();
  const pulls = lists.flatMap((list) => list.pulls).filter((entry) => {
    const key = `${entry.project_id}:${entry.pull.number}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const failed = lists.flatMap((list) => list.failed).filter((one, at, all) => all.findIndex((other) => other.project_id === one.project_id) === at);
  return { pulls, failed };
}

const sentence = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

export function PullsPage() {
  const [text, setText] = useState("");
  const [tokens, setTokens] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState("");
  const [sort, setSort] = useState<PullSort>(defaultSort);
  const [filters, setFilters] = useState<PullFilters>(noFilters);
  const route = useRoute();
  const selected = route.name === "pulls" && route.project !== undefined && route.number !== undefined ? { project: route.project, number: route.number } : null;
  const setSelected = (next: { project: string; number: number } | null) =>
    navigate(next ? { name: "pulls", project: next.project, number: next.number } : { name: "pulls" });
  const [picked, setPicked] = useState<PullListEntry[]>([]);
  const [merging, setMerging] = useState<PullListEntry | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const projects = useVisibleProjects();
  const phone = useLayoutWidth() === "phone";
  const asked = statesToAsk(filters.states);
  const list = useAsync(`pulls:${[...asked].sort().join("+")}:${submitted}`, (signal) => loadPulls(asked, submitted, signal));
  const all = useMemo(() => list.data?.pulls ?? [], [list.data]);
  // Without a creation time the number orders by date, which only means something inside one repository.
  const oneRepo = pullData.createdAt || filters.project !== null || new Set(all.map((entry) => entry.project_id)).size <= 1;
  const orderBy = oneRepo || sort.by !== "created" ? sort : defaultSort;
  const rows = useMemo(() => visiblePulls(all, filters, tokens, orderBy, null), [all, filters, tokens, orderBy]);
  const refresh = () => void list.reload();
  const loading = list.status === "loading";
  const refreshing = list.status === "ready" && list.refreshing;
  // A load that finishes inside 400 ms shows nothing under the header. A longer one shows the
  // static skeleton, and the rows then fade in as it leaves.
  const skeletonShown = useWaited(loading);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (loading) setRevealed(skeletonShown);
  }, [loading, skeletonShown]);
  const loadedAt = useMemo(() => (list.data ? Date.now() : null), [list.data]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const quick = (work: Promise<unknown>, done: string) => {
    work.then(
      () => {
        pushToast(done);
        refresh();
      },
      (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`),
    );
  };
  const closePicked = async () => {
    const byProject = new Map<string, number[]>();
    for (const { project_id: project, pull } of picked) byProject.set(project, [...(byProject.get(project) ?? []), pull.number]);
    try {
      const results = await Promise.all([...byProject].map(([project, numbers]) => pullsApi.closeMany(project, numbers)));
      const failed = results.flat().filter((result) => !result.ok);
      pushToast(failed.length > 0 ? `Couldn't close ${failed.map((result) => `#${result.number}`).join(", ")}` : `Closed ${picked.length}`);
      setPicked([]);
      refresh();
    } catch (failure) {
      pushToast(`Couldn't close those. ${toFailure(failure).message}`);
    }
  };
  const nameOf = (id: string) => projects?.find((project) => project.id === id)?.name ?? "";
  const count = (test: (pull: PullListEntry["pull"]) => boolean) => all.filter(({ pull }) => test(pull)).length;
  const toolbarProjects = (projects ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    color: project.project_icon && project.project_icon.kind !== "emoji" ? project.project_icon.color : deriveProjectIdentity(project.name).color,
    count: all.filter((entry) => entry.project_id === project.id).length,
  }));
  const labelCounts = labelsOf(all).map((name) => ({ name, count: count((pull) => pull.labels.includes(name)) }));
  const chips = activeChips(filters);
  const criteria = [
    ...(submitted ? [`"${submitted}"`] : []),
    ...tokens.map((token) => `label:${token}`),
    ...chips.map((chip) => chip.label),
    ...(filters.project ? [`Project: ${nameOf(filters.project)}`] : []),
  ];
  const clearAll = () => {
    setFilters(clearedFilters({ ...filters, project: null }));
    setTokens([]);
    setText("");
    setSubmitted("");
  };
  const refreshButton = (
    <IconButton label="Refresh" aria-busy={loading || refreshing || undefined} onClick={refresh}>
      {loading || refreshing ? <i className="pulls-refresh-spin spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
    </IconButton>
  );

  const tableHead = (
    <div className="pulls-head" aria-hidden>
      <span />
      <span>Pull request</span>
      <span>Checks</span>
      <span>Review</span>
      <span>Updated</span>
      <span />
    </div>
  );

  if (selected) {
    return (
      <div className="pulls-page">
        <PullDetail
          layout="page"
          key={`${selected.project}:${selected.number}`}
          projectId={selected.project}
          number={selected.number}
          onBack={() => {
            setSelected(null);
            refresh();
          }}
          onOpen={(number) => setSelected({ project: selected.project, number })}
        />
      </div>
    );
  }

  return (
    <div className="pulls-page">
      <PageBar
        actions={
          phone ? undefined : (
            <>
              <span className="pulls-upd" role="status">
                {loading ? "Loading" : refreshing ? "Refreshing" : loadedAt ? `Updated ${relativeTime(new Date(loadedAt).toISOString(), now).toLowerCase()}` : ""}
              </span>
              {refreshButton}
            </>
          )
        }
      >
        <h1 tabIndex={-1} data-page-title>
          Pull requests
        </h1>
      </PageBar>
      <PullsToolbar
        openCount={count((pull) => pull.state === "open")}
        draftCount={count((pull) => pull.state === "open" && pull.draft)}
        loading={loading}
        filters={filters}
        onFilters={setFilters}
        sort={orderBy}
        oneRepo={oneRepo}
        has={pullData}
        onSort={setSort}
        text={text}
        onText={setText}
        tokens={tokens}
        onTokens={setTokens}
        onSubmit={setSubmitted}
        projects={toolbarProjects}
        allCount={all.length}
        authors={authorsOf(all)}
        labels={labelCounts}
        shown={rows.length}
        phone={phone}
        phoneRefresh={phone ? refreshButton : undefined}
      />
      <div className="pulls-table">
        {picked.length > 0 ? (
          <div className="pulls-bulk" role="status">
            <span>{picked.length} selected</span>
            <Button small tone="danger" onClick={() => void closePicked()}>
              Close selected
            </Button>
            <Button small tone="quiet" onClick={() => setPicked([])}>
              Clear
            </Button>
          </div>
        ) : null}
        {loading ? (
          <>
            {tableHead}
            {skeletonShown ? (
              <ul className="pull-rows pull-skel" aria-hidden>
                {Array.from({ length: 6 }, (_, at) => (
                  <li key={at}>
                    <i className="pull-skel-icon" />
                    <span className="pull-skel-title">
                      <i style={{ width: "55%" }} />
                      <i style={{ width: "30%" }} />
                    </span>
                    <i className="pull-skel-checks" />
                    <i className="pull-skel-review" />
                    <i className="pull-skel-updated" />
                    <span />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : list.status === "error" ? (
          <ErrorState title="Couldn't load pull requests" failure={list.error} onRetry={list.reload} />
        ) : rows.length === 0 && criteria.length > 0 ? (
          <div className="pulls-nomatch">
            <Search size={20} aria-hidden />
            <b>No pull requests match</b>
            <p>
              {filters.project
                ? `No pull requests in ${nameOf(filters.project)} match these filters.`
                : `Nothing in ${sentence(filters.states.map((state) => state[0]!.toUpperCase() + state.slice(1)))} matches ${sentence(criteria)}.`}
            </p>
            <Button icon={<X size={14} aria-hidden />} tone="primary" onClick={clearAll}>
              Clear filters
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="pulls-empty">
            <GitPullRequest size={32} aria-hidden />
            <h2>No pull requests</h2>
            <p>Pull requests from every project in this workspace appear here.</p>
            {list.data.failed.map((failure) => (
              <p key={failure.project_id} className="muted">
                {nameOf(failure.project_id)}: {failure.message}
              </p>
            ))}
          </div>
        ) : (
          <>
            {tableHead}
            <ul className="pull-rows" data-reveal={revealed || undefined}>
              {rows.map((entry) => {
                const { project_id: project, pull } = entry;
                const isPicked = picked.some((one) => one.project_id === project && one.pull.number === pull.number);
                const checks = checksOf(pull.checks_state);
                const review = pull.draft ? "Draft" : (REVIEWS[pull.review_state ?? "none"] ?? "");
                return (
                  <li
                    key={`${project}:${pull.number}`}
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest("button, input, a")) setSelected({ project, number: pull.number });
                    }}
                  >
                    <input
                      type="checkbox"
                      className="pull-row-pick"
                      aria-label={`Select #${pull.number}`}
                      checked={isPicked}
                      onChange={() =>
                        setPicked(isPicked ? picked.filter((one) => !(one.project_id === project && one.pull.number === pull.number)) : [...picked, entry])
                      }
                    />
                    <button type="button" className="pull-open" onClick={() => setSelected({ project, number: pull.number })}>
                      <span className="pull-row-name" data-draft={pull.draft || undefined}>
                        {pull.draft ? "Draft · " : ""}
                        {pull.title}
                      </span>
                      <small>{[`#${pull.number}`, pull.head, nameOf(project), pull.author].filter(Boolean).join(" · ")}</small>
                    </button>
                    <span className="pull-checks-cell" data-tone={checks}>
                      {checks === "pass" ? <Check size={12} aria-hidden /> : null}
                      {checks === "fail" ? <X size={12} aria-hidden /> : null}
                      {checks === "pending" ? <span className="pull-spin spin" aria-hidden /> : null}
                      <span className="pull-checks-word">
                        <span className="sr-only">Checks </span>
                        {CHECKS[checks]}
                      </span>
                    </span>
                    <span className="pull-review-cell" data-tone={pull.review_state === "changes_requested" && !pull.draft ? "warn" : undefined}>
                      {review}
                    </span>
                    <span className="pull-age">{pull.updated_at ? compactAge(pull.updated_at) : ""}</span>
                    <span className="pull-row-actions">
                      {pull.state === "closed" ? (
                        <IconButton label={`Reopen #${pull.number}`} onClick={() => quick(pullsApi.action(project, pull.number, "reopen"), "Reopened")}>
                          <CircleDot size={14} aria-hidden />
                        </IconButton>
                      ) : null}
                      {pull.state === "open" && pull.draft ? (
                        <IconButton label={`Ready for review #${pull.number}`} onClick={() => quick(pullsApi.update(project, pull.number, { draft: false }), "Ready for review")}>
                          <CircleCheck size={14} aria-hidden />
                        </IconButton>
                      ) : null}
                      {pull.state === "open" ? (
                        <>
                          <IconButton label={`Merge #${pull.number}`} onClick={() => setMerging(entry)}>
                            <GitMerge size={14} aria-hidden />
                          </IconButton>
                          <IconButton label={`Close #${pull.number}`} onClick={() => quick(pullsApi.action(project, pull.number, "close"), "Closed")}>
                            <CircleX size={14} aria-hidden />
                          </IconButton>
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      {merging ? (
        <ConfirmDialog
          title={`Merge #${merging.pull.number}?`}
          confirmLabel="Merge"
          onClose={() => setMerging(null)}
          onConfirm={async () => {
            await pullsApi.merge(merging.project_id, merging.pull.number, {
              method: "squash",
              auto: false,
              delete_branch: true,
              strip_credits: false,
            });
            refresh();
          }}
        >
          <p>{merging.pull.title} is squashed into {merging.pull.base} and its branch is deleted.</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
