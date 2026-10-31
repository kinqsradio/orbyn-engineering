import { ArrowUpDown, Check, Folder, GitPullRequest, ListFilter, RefreshCw, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { compactAge } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { useVisibleProjects } from "../../state/workspace";
import { IconButton } from "../../ui/controls";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ErrorState, Loading } from "../../ui/states";
import { PullDetail } from "./PullDetail";
import { noFilters, parseSearch, visiblePulls, type PullFilters, type PullSort } from "./pullModel";
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
  const projects = useVisibleProjects();
  const { query, labels } = parseSearch(submitted);
  const list = useAsync(`pulls:${state}:${query}:${nonce}`, (signal) => pullsApi.list(state, query, signal));
  const rows = useMemo(
    () => visiblePulls(list.data?.pulls ?? [], filters, labels, sort),
    [list.data, filters, labels, sort],
  );
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
            <IconButton label="Refresh pull requests" onClick={() => setNonce(nonce + 1)}>
              <RefreshCw size={14} aria-hidden />
            </IconButton>
          </div>
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
              {rows.map(({ project_id: project, pull }) => (
                <li key={`${project}:${pull.number}`}>
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
                </li>
              ))}
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
            />
          </div>
        ) : null}
      </div>
      {menu ? <Menu x={menu.x} y={menu.y} label="Pull request options" items={items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
