import { Check, ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Segmented } from "../../ui/Segmented";
import { Button, IconButton } from "../../ui/controls";
import { ToolbarPopover } from "./ToolbarPopover";
import "./pullsToolbar.css";
import {
  activeChips,
  clearedFilters,
  takeLabels,
  sortName,
  type CheckKey,
  type PullFilters,
  type PullSort,
  type PullState,
  type ReviewKey,
} from "./pullModel";

export interface ToolbarProject {
  id: string;
  name: string;
  /** A project colour name, as `project-color-*` knows it. */
  color: string;
  count: number;
}

export interface ToolbarProps {
  openCount: number;
  draftCount: number;
  filters: PullFilters;
  onFilters(next: PullFilters): void;
  sort: PullSort;
  onSort(next: PullSort): void;
  text: string;
  onText(next: string): void;
  tokens: string[];
  onTokens(next: string[]): void;
  /** Runs the typed words as the search. */
  onSubmit(query: string): void;
  projects: ToolbarProject[];
  allCount: number;
  authors: string[];
  labels: { name: string; count: number }[];
  /** How many rows the current filters leave, for the phone sheet's button. */
  shown: number;
  phone: boolean;
  /** On a phone the refresh button sits beside the search. */
  phoneRefresh?: ReactNode;
}

type Kind = "project" | "filters" | "sort";

const toggle = <T,>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((one) => one !== value) : [...list, value]);

const STATE_OPTIONS: { value: PullState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
];
const REVIEW_OPTIONS: { value: ReviewKey; label: string }[] = [
  { value: "review_required", label: "Review required" },
  { value: "approved", label: "Approved" },
  { value: "changes_requested", label: "Changes requested" },
];
const CHECK_OPTIONS: { value: CheckKey; label: string }[] = [
  { value: "passing", label: "Passing" },
  { value: "failing", label: "Failing" },
  { value: "running", label: "Running" },
];

function Tick({ on, label, count, onClick }: { on: boolean; label: string; count?: number; onClick(): void }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} className="pulls-mi" onClick={onClick}>
      <span className="pulls-cbx" aria-hidden>
        {on ? <Check size={10} strokeWidth={3} /> : null}
      </span>
      {label}
      {count !== undefined ? <span className="pulls-k">{count}</span> : null}
    </button>
  );
}

function SearchBox({ placeholder, value, onChange, label }: { placeholder: string; value: string; onChange(next: string): void; label: string }) {
  return (
    <div className="pulls-fld pulls-fld-menu">
      <div className="pulls-inp">
        <Search size={14} aria-hidden />
        <input aria-label={label} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      </div>
    </div>
  );
}

function FilterPanel({ props, count, sheet, dismiss }: { props: ToolbarProps; count: number; sheet: boolean; dismiss(): void }) {
  const { filters, onFilters } = props;
  const [authorFind, setAuthorFind] = useState("");
  const [labelFind, setLabelFind] = useState("");
  const set = (patch: Partial<PullFilters>) => onFilters({ ...filters, ...patch });
  const authors = authorFind.trim() ? props.authors.filter((name) => name.toLowerCase().includes(authorFind.trim().toLowerCase())).slice(0, 6) : [];
  const labels = props.labels.filter((entry) => entry.name.toLowerCase().includes(labelFind.trim().toLowerCase()));
  const clearAll = () => {
    onFilters(clearedFilters(filters));
  };

  const state = (
    <>
      <div className="pulls-mh">State</div>
      {STATE_OPTIONS.map((entry) => (
        <Tick
          key={entry.value}
          on={filters.states.includes(entry.value)}
          label={entry.label}
          onClick={() => {
            const next = toggle(filters.states, entry.value);
            set({ states: next.length > 0 ? next : ["open"] });
          }}
        />
      ))}
    </>
  );
  const draft = (
    <>
      <div className="pulls-mh">Draft</div>
      <div className="pulls-msub">
        <Segmented
          label="Draft"
          value={filters.draft}
          options={[
            { value: "all", label: "Include" },
            { value: "hide", label: "Exclude" },
            { value: "only", label: "Only" },
          ]}
          onChange={(draftValue) => set({ draft: draftValue })}
        />
      </div>
    </>
  );
  const review = (
    <>
      <div className="pulls-mh">Review</div>
      {REVIEW_OPTIONS.map((entry) => (
        <Tick key={entry.value} on={filters.review.includes(entry.value)} label={entry.label} onClick={() => set({ review: toggle(filters.review, entry.value) })} />
      ))}
    </>
  );
  const checks = (
    <>
      <div className="pulls-mh">Checks</div>
      {CHECK_OPTIONS.map((entry) => (
        <Tick key={entry.value} on={filters.checks.includes(entry.value)} label={entry.label} onClick={() => set({ checks: toggle(filters.checks, entry.value) })} />
      ))}
    </>
  );
  const author = (
    <>
      <div className="pulls-mh">Author</div>
      <div className="pulls-msub">
        <Segmented
          label="Author"
          value={filters.me ? "me" : filters.author ? "named" : "anyone"}
          options={[
            { value: "me", label: "Me" },
            { value: "anyone", label: "Anyone" },
          ]}
          onChange={(who) => set({ me: who === "me", author: null })}
        />
        <SearchBox label="Search people" placeholder="Search people" value={authorFind} onChange={setAuthorFind} />
      </div>
      {authors.map((name) => (
        <Tick key={name} on={filters.author === name} label={name} onClick={() => set({ author: filters.author === name ? null : name, me: false })} />
      ))}
    </>
  );
  const label = (
    <>
      <div className="pulls-mh">Label</div>
      <div className="pulls-msub">
        <SearchBox label="Search labels" placeholder="Search labels" value={labelFind} onChange={setLabelFind} />
      </div>
      {labels.map((entry) => (
        <Tick
          key={entry.name}
          on={filters.labels.includes(entry.name)}
          label={entry.name}
          count={entry.count}
          onClick={() => set({ labels: toggle(filters.labels, entry.name) })}
        />
      ))}
    </>
  );

  if (sheet) {
    return (
      <>
        <span className="pulls-grab" aria-hidden />
        <div className="pulls-sheet-head">
          <b>Filters</b>
          <span className="pulls-sheet-acts">
            <button type="button" className="pulls-ghost" onClick={clearAll}>
              Clear all
            </button>
            <IconButton label="Close filters" onClick={dismiss}>
              <X size={14} aria-hidden />
            </IconButton>
          </span>
        </div>
        {state}
        {draft}
        {review}
        {checks}
        {author}
        {label}
        <Button tone="primary" className="pulls-show" onClick={dismiss}>
          Show {props.shown} pull {props.shown === 1 ? "request" : "requests"}
        </Button>
      </>
    );
  }
  return (
    <>
      <div className="pulls-mcols">
        <div className="pulls-mc">
          {state}
          {draft}
          {review}
          {checks}
        </div>
        <div className="pulls-mc">
          {author}
          {label}
        </div>
      </div>
      <div className="pulls-mfoot">
        <button type="button" className="pulls-ghost" onClick={clearAll}>
          Clear all
        </button>
        <span className="pulls-mcount">{count} active</span>
      </div>
    </>
  );
}

export function PullsToolbar(props: ToolbarProps) {
  const { filters, onFilters, sort, onSort, text, onText, tokens, onTokens, onSubmit } = props;
  const [menu, setMenu] = useState<{ kind: Kind; anchor: HTMLElement } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const chips = useMemo(() => activeChips(filters), [filters]);
  const count = chips.length;
  const project = props.projects.find((entry) => entry.id === filters.project);

  // "/" jumps to the search from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      event.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const commitTokens = (value: string, final: boolean, submit = false) => {
    const taken = takeLabels(value, final);
    if (taken.labels.length > 0) {
      const merged = [...new Set([...tokens, ...taken.labels])];
      if (merged.length !== tokens.length) onTokens(merged);
    }
    onText(taken.labels.length > 0 || final ? taken.rest : value);
    if (submit) onSubmit(taken.rest);
  };
  const clearSearch = () => {
    onText("");
    onTokens([]);
    onSubmit("");
  };
  const open = (kind: Kind) => (event: React.MouseEvent<HTMLElement>) => {
    const anchor = event.currentTarget;
    setMenu(menu?.kind === kind ? null : { kind, anchor });
  };
  const sheet = props.phone;

  const dots = project ? [project] : props.projects.slice(0, 3);
  const searchField = (
    <div className="pulls-fld" data-focus-scope>
      <div className="pulls-inp">
        <Search size={14} aria-hidden />
        {tokens.map((token) => (
          <span key={token} className="pulls-tok">
            label:{token}
            <button type="button" className="pulls-x" aria-label={`Remove label:${token}`} onClick={() => onTokens(tokens.filter((one) => one !== token))}>
              <X size={10} aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={field}
          aria-label="Search pull requests"
          placeholder={tokens.length > 0 ? "" : "Search, or label:bug"}
          value={text}
          onChange={(event) => {
            commitTokens(event.target.value, false);
          }}
          onBlur={() => commitTokens(text, true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitTokens(text, true, true);
            else if (event.key === "Escape" && (text || tokens.length > 0)) {
              event.stopPropagation();
              clearSearch();
            } else if (event.key === "Backspace" && !text && tokens.length > 0) onTokens(tokens.slice(0, -1));
          }}
        />
        {text || tokens.length > 0 ? (
          <button type="button" className="pulls-x pulls-clear" aria-label="Clear search" onClick={() => { clearSearch(); field.current?.focus(); }}>
            <X size={12} aria-hidden />
          </button>
        ) : (
          <kbd aria-hidden>/</kbd>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="pulls-tb">
        <div className="pulls-tbp" role="group" aria-label="Quick filters">
          <button
            type="button"
            className="pulls-pill"
            aria-pressed={filters.states.length === 1 && filters.states[0] === "open" && filters.draft === "all"}
            onClick={() => onFilters({ ...filters, states: ["open"], draft: "all" })}
          >
            Open · {props.openCount}
          </button>
          <button
            type="button"
            className="pulls-pill"
            aria-pressed={filters.states.length === 1 && filters.states[0] === "open" && filters.draft === "only"}
            onClick={() => onFilters({ ...filters, states: ["open"], draft: "only" })}
          >
            Drafts · {props.draftCount}
          </button>
          {(["merged", "closed"] as const).map((state) => (
            <button
              key={state}
              type="button"
              className="pulls-pill"
              aria-pressed={filters.states.length === 1 && filters.states[0] === state && filters.draft === "all"}
              onClick={() => onFilters({ ...filters, states: [state], draft: "all" })}
            >
              {state === "merged" ? "Merged" : "Closed"}
            </button>
          ))}
        </div>
        <div className="pulls-tbr">
          <div className="pulls-searchrow">
            {searchField}
            {props.phoneRefresh}
          </div>
          <div className="pulls-sels">
            <button type="button" className="pulls-sel" aria-haspopup="menu" aria-expanded={menu?.kind === "project"} data-on={menu?.kind === "project" || undefined} onClick={open("project")}>
              <span className="pulls-dots" aria-hidden>
                {dots.map((entry) => (
                  <i key={entry.id} className={`project-color-${entry.color}`} />
                ))}
              </span>
              {project ? project.name : "All projects"}
              <ChevronDown size={14} aria-hidden />
            </button>
            <button type="button" className="pulls-sel" aria-haspopup="dialog" aria-expanded={menu?.kind === "filters"} data-on={menu?.kind === "filters" || count > 0 || undefined} onClick={open("filters")}>
              <SlidersHorizontal size={14} aria-hidden />
              {count > 0 ? `Filters · ${count}` : "Filters"}
            </button>
            <button type="button" className="pulls-sel" aria-haspopup="menu" aria-expanded={menu?.kind === "sort"} data-on={menu?.kind === "sort" || undefined} onClick={open("sort")}>
              Sort: {sortName(sort)}
              <ChevronDown size={14} aria-hidden />
            </button>
          </div>
        </div>
      </div>
      {chips.length > 0 ? (
        <div className="pulls-chiprow" role="group" aria-label="Active filters">
          {chips.map((chip) => (
            <span key={chip.id} className="pulls-fchip">
              {chip.label}
              <button type="button" className="pulls-x" aria-label={`Remove filter ${chip.label}`} onClick={() => onFilters(chip.remove(filters))}>
                <X size={10} aria-hidden />
              </button>
            </span>
          ))}
          <button type="button" className="pulls-ghost" onClick={() => onFilters(clearedFilters(filters))}>
            Clear all
          </button>
        </div>
      ) : null}
      {menu?.kind === "project" ? (
        <ToolbarPopover anchor={menu.anchor} label="Project" role="menu" width={240} onClose={() => setMenu(null)}>
          {(dismiss) => (
            <>
              <div className="pulls-mh">Project</div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={filters.project === null}
                className="pulls-mi"
                onClick={() => {
                  onFilters({ ...filters, project: null });
                  dismiss();
                }}
              >
                <span className="pulls-lead">{filters.project === null ? <Check size={14} aria-hidden /> : null}</span>
                All projects
                <span className="pulls-k">{props.allCount}</span>
              </button>
              {props.projects.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={filters.project === entry.id}
                  className="pulls-mi"
                  onClick={() => {
                    onFilters({ ...filters, project: entry.id });
                    dismiss();
                  }}
                >
                  <span className="pulls-lead">
                    <i className={`pulls-dot project-color-${entry.color}`} />
                  </span>
                  {entry.name}
                  <span className="pulls-k">{entry.count}</span>
                </button>
              ))}
            </>
          )}
        </ToolbarPopover>
      ) : null}
      {menu?.kind === "sort" ? (
        <ToolbarPopover anchor={menu.anchor} label="Sort" role="menu" width={200} onClose={() => setMenu(null)}>
          {(dismiss) => (
            <>
              <div className="pulls-mh">Sort by</div>
              {(
                [
                  { label: "Updated", on: sort.by === "updated", to: { by: "updated", dir: sort.dir } },
                  { label: "Created", on: sort.by === "created" && sort.dir === "newest", to: { by: "created", dir: "newest" } },
                  { label: "Most comments", on: false, to: null },
                  { label: "Oldest", on: sort.by === "created" && sort.dir === "oldest", to: { by: "created", dir: "oldest" } },
                ] as { label: string; on: boolean; to: PullSort | null }[]
              ).map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  role="menuitemradio"
                  aria-checked={entry.on}
                  disabled={entry.to === null}
                  title={entry.to === null ? "The forge does not report comment counts" : undefined}
                  className="pulls-mi"
                  onClick={() => {
                    if (entry.to) onSort(entry.to);
                    dismiss();
                  }}
                >
                  <span className="pulls-lead">{entry.on ? <Check size={14} aria-hidden /> : null}</span>
                  {entry.label}
                </button>
              ))}
              <hr className="pulls-msep" />
              <div className="pulls-mh">Direction</div>
              <div className="pulls-msub">
                <Segmented
                  label="Direction"
                  value={sort.dir}
                  options={[
                    { value: "newest", label: "Newest first" },
                    { value: "oldest", label: "Oldest first" },
                  ]}
                  onChange={(dir) => onSort({ ...sort, dir })}
                />
              </div>
            </>
          )}
        </ToolbarPopover>
      ) : null}
      {menu?.kind === "filters" ? (
        <ToolbarPopover anchor={menu.anchor} label="Filters" layout={sheet ? "sheet" : "popover"} width={470} onClose={() => setMenu(null)}>
          {(dismiss) => <FilterPanel props={props} count={count} sheet={sheet} dismiss={dismiss} />}
        </ToolbarPopover>
      ) : null}
    </>
  );
}
