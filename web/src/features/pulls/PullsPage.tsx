import { ArrowUpDown, Check, CircleCheck, CircleDot, CircleX, Folder, GitMerge, GitPullRequest, ListFilter, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { PullListEntry } from "../../api/types";
import { compactAge } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects } from "../../state/workspace";
import { Button, IconButton } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ErrorState, Loading } from "../../ui/states";
import { PullDetail } from "./PullDetail";
import { authorsOf, labelsOf, noFilters, parseSearch, visiblePulls, type PullFilters, type PullSort } from "./pullModel";
import { pullsApi } from "./pullsApi";

const SORTS: { value: PullSort; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "newest", label: "Newest shown" },
  { value: "oldest", label: "Oldest shown" },
];

const STATES = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];

type Open = { kind: "sort" | "filters" | "project"; x: number; y: number };

export function PullsPage() {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [state, setState] = useState("open");
  const [sort, setSort] = useState<PullSort>("updated");
  const [filters, setFilters] = useState<PullFilters>(noFilters);
  const [menu, setMenu] = useState<Open | null>(null);
  const [selected, setSelected] = useState<{ project: string; number: number } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [picked, setPicked] = useState<PullListEntry[]>([]);
  const [merging, setMerging] = useState<PullListEntry | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const projects = useVisibleProjects();
  const { query, labels } = parseSearch(submitted);
  const list = useAsync(`pulls:${state}:${query}:${nonce}`, (signal) => pullsApi.list(state, query, signal));
  const rows = useMemo(
    () => visiblePulls(list.data?.pulls ?? [], filters, labels, sort),
    [list.data, filters, labels, sort],
  );
  const refresh = () => setNonce((value) => value + 1);
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
  const open = (kind: Open["kind"], element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setMenu({ kind, x: rect.left, y: rect.bottom + 4 });
  };
  const nameOf = (id: string) => projects?.find((project) => project.id === id)?.name ?? "";
  const choice = <K extends keyof PullFilters>(key: K, value: PullFilters[K], label: string): MenuItem => ({
    label,
    selected: filters[key] === value,
    onSelect: () => setFilters({ ...filters, [key]: value }),
  });
  const items: MenuItem[] =
    menu?.kind === "sort"
      ? SORTS.map((entry) => ({ label: entry.label, selected: sort === entry.value, onSelect: () => setSort(entry.value) }))
      : menu?.kind === "project"
        ? [
            { label: "All projects", selected: filters.project === null, onSelect: () => setFilters({ ...filters, project: null }) },
            ...(projects ?? []).map((project) => choice("project", project.id, project.name)),
          ]
        : [
            {
              label: "State",
              children: STATES.map((entry) => ({
                label: entry.label,
                selected: state === entry.value,
                onSelect: () => setState(entry.value),
              })),
            },
            {
              label: "Draft",
              children: [choice("draft", "all", "All"), choice("draft", "only", "Drafts only"), choice("draft", "hide", "Hide drafts")],
            },
            {
              label: "Review",
              children: [
                choice("review", "all", "All"),
                choice("review", "approved", "Approved"),
                choice("review", "changes_requested", "Changes requested"),
                choice("review", "review_required", "Review required"),
                choice("review", "none", "No reviews"),
              ],
            },
            {
              label: "Checks",
              children: [choice("checks", "all", "All"), choice("checks", "passing", "Passing"), choice("checks", "failing", "Failing")],
            },
            {
              label: "Author",
              children: [choice("author", null, "Anyone"), ...authorsOf(list.data?.pulls ?? []).map((name) => choice("author", name, name))],
            },
            {
              label: "Label",
              children: [choice("label", null, "Any"), ...labelsOf(list.data?.pulls ?? []).map((name) => choice("label", name, name))],
            },
          ];

  return (
    <div className="pulls-page">
      <header className="topbar">
        <div className="crumbs">
          <h1 tabIndex={-1} data-page-title>
            Pull requests
          </h1>
        </div>
      </header>
      <div className="pulls-columns">
        <div className="pulls-list-column">
          <div className="pulls-bar">
            <label className="pulls-search">
              <Search size={14} aria-hidden />
              <input
                aria-label="Search pull requests"
                placeholder="Search pull requests, or label:bug"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setSubmitted(text);
                }}
              />
              {text ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setText("");
                    setSubmitted("");
                  }}
                >
                  <X size={12} aria-hidden />
                </button>
              ) : null}
            </label>
            <button type="button" className="pulls-chip" onClick={(event) => open("sort", event.currentTarget)}>
              <ArrowUpDown size={14} aria-hidden />
              Sort
            </button>
            <button type="button" className="pulls-chip" onClick={(event) => open("filters", event.currentTarget)}>
              <ListFilter size={14} aria-hidden />
              Filters
            </button>
            <button type="button" className="pulls-chip" onClick={(event) => open("project", event.currentTarget)}>
              <Folder size={14} aria-hidden />
              {filters.project ? nameOf(filters.project) : "All"}
            </button>
            <IconButton label="Refresh pull requests" onClick={refresh}>
              <RefreshCw size={14} aria-hidden />
            </IconButton>
          </div>
          {picked.length > 0 ? (
            <div className="pulls-bulk" role="status">
              <span>{picked.length} selected</span>
              <Button small onClick={() => void closePicked()}>
                Close selected
              </Button>
              <Button small tone="quiet" onClick={() => setPicked([])}>
                Clear
              </Button>
            </div>
          ) : null}
          {list.status === "loading" ? (
            <Loading label="Loading pull requests" rows={5} />
          ) : list.status === "error" ? (
            <ErrorState title="Couldn't load pull requests" failure={list.error} onRetry={list.reload} />
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
            <ul className="pulls-list">
              {rows.map((entry) => {
                const { project_id: project, pull } = entry;
                const isPicked = picked.some((one) => one.project_id === project && one.pull.number === pull.number);
                return (
                <li key={`${project}:${pull.number}`}>
                  <input
                    type="checkbox"
                    className="pull-pick"
                    aria-label={`Select #${pull.number}`}
                    checked={isPicked}
                    onChange={() =>
                      setPicked(isPicked ? picked.filter((one) => !(one.project_id === project && one.pull.number === pull.number)) : [...picked, entry])
                    }
                  />
                  <button
                    type="button"
                    aria-current={selected?.project === project && selected.number === pull.number ? "true" : undefined}
                    onClick={() => setSelected({ project, number: pull.number })}
                  >
                    <GitPullRequest size={14} aria-hidden />
                    <span className="pull-row-title">{pull.title}</span>
                    {pull.checks_state === "passing" ? <Check size={12} className="tone-success" aria-label="Checks passing" /> : null}
                    {pull.checks_state === "failing" ? <X size={12} className="tone-danger" aria-label="Checks failing" /> : null}
                    <small>
                      {nameOf(project)} #{pull.number}
                      {pull.author ? ` · ${pull.author}` : ""}
                      {pull.updated_at ? ` · ${compactAge(pull.updated_at)}` : ""}
                    </small>
                  </button>
                  <span className="pull-quick">
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
          )}
        </div>
        {selected ? (
          <div className="pulls-detail-column">
            <PullDetail
              key={`${selected.project}:${selected.number}`}
              projectId={selected.project}
              number={selected.number}
              onClose={() => setSelected(null)}
              onOpen={(number) => setSelected({ project: selected.project, number })}
            />
          </div>
        ) : null}
      </div>
      {menu ? <Menu x={menu.x} y={menu.y} label="Pull request options" items={items} onClose={() => setMenu(null)} /> : null}
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
