import { ChevronRight, Copy, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { FileDiff } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { useThreadLogs } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";

const LINE_LIMIT = 2000;

export type DiffLine = { kind: "hunk" | "add" | "del" | "ctx" | "meta"; text: string };

export function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((text) => {
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+++") || text.startsWith("---")) return { kind: "meta", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "del", text };
    if (text.startsWith("\\") || text.startsWith("diff ") || text.startsWith("index ")) {
      return { kind: "meta", text };
    }
    return { kind: "ctx", text };
  });
}

const markers: Record<DiffLine["kind"], string | null> = {
  add: "Added",
  del: "Removed",
  hunk: null,
  ctx: null,
  meta: null,
};

/** Drops changed pairs that differ only in spacing, as `git diff -w` would show them. */
export function withoutWhitespaceChanges(lines: DiffLine[]): DiffLine[] {
  const squash = (text: string) => text.slice(1).replace(/\s+/g, "");
  const out: DiffLine[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at];
    const next = lines[at + 1];
    if (line?.kind === "del" && next?.kind === "add" && squash(line.text) === squash(next.text)) {
      out.push({ kind: "ctx", text: ` ${next.text.slice(1)}` });
      at += 1;
    } else if (line) {
      out.push(line);
    }
  }
  return out;
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs each run of removals with the additions after it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let at = 0; at < Math.max(removed.length, added.length); at += 1) {
      rows.push({ left: removed[at] ?? null, right: added[at] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "del") {
      if (added.length > 0) flush();
      removed.push(line);
    } else if (line.kind === "add") {
      added.push(line);
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

function LineCell({ line, find }: { line: DiffLine | null; find: string }) {
  if (!line) return <div className="patch-line patch-empty"> </div>;
  const marker = markers[line.kind];
  const hit = find !== "" && line.text.toLowerCase().includes(find);
  return (
    <div className={`patch-line patch-${line.kind}`} data-hit={hit || undefined}>
      {marker ? <span className="sr-only">{marker}: </span> : null}
      {line.text || " "}
    </div>
  );
}

function Patch({ patch, find }: { patch: string; find: string }) {
  const ignoreSpace = useUi((state) => state.diffIgnoreWhitespace);
  const layout = useUi((state) => state.diffLayout);
  const lines = useMemo(() => {
    const parsed = parsePatch(patch);
    return ignoreSpace ? withoutWhitespaceChanges(parsed) : parsed;
  }, [patch, ignoreSpace]);
  const [all, setAll] = useState(false);
  const visible = all ? lines : lines.slice(0, LINE_LIMIT);
  if (lines.length === 0) return <p className="muted diff-binary">No text changes to show.</p>;
  return (
    <>
      <div className="patch" tabIndex={0} role="group" aria-label="Patch" data-layout={layout}>
        <div className="patch-inner">
          {layout === "split"
            ? splitRows(visible).map((row, at) => (
                <div key={at} className="patch-split">
                  <LineCell line={row.left} find={find} />
                  <LineCell line={row.right} find={find} />
                </div>
              ))
            : visible.map((line, at) => <LineCell key={at} line={line} find={find} />)}
        </div>
      </div>
      {lines.length > visible.length ? (
        <Button small tone="quiet" onClick={() => setAll(true)}>
          Show {lines.length - visible.length} more lines
        </Button>
      ) : null}
    </>
  );
}

type DiffSource = "worktree" | "turn" | "thread" | "branch" | "commit";
const TEST_FILE = /(^|\/)(__tests__|tests?|e2e|spec)\/|\.(test|spec)\.[a-z]+$/i;

const DIFF_SOURCES: { id: DiffSource; label: string }[] = [
  { id: "worktree", label: "Working tree" },
  { id: "turn", label: "Turn" },
  { id: "thread", label: "Thread" },
  { id: "branch", label: "Branch" },
  { id: "commit", label: "Commit" },
];

const STATUS_LETTER: Record<string, string> = { added: "A", deleted: "D", renamed: "R", modified: "M" };

function FileRow({ file, open, find, onToggle }: { file: FileDiff; open: boolean; find: string; onToggle(): void }) {
  const pushToast = useUi((state) => state.pushToast);
  return (
    <li className="diff-file" data-diff-file={file.path}>
      <div className="diff-file-head">
        <button type="button" className="diff-file-row" aria-expanded={open} onClick={onToggle}>
          <ChevronRight size={16} className="chev" aria-hidden />
          <span className="diff-status" data-status={file.status} title={file.status}>
            {STATUS_LETTER[file.status] ?? "?"}
          </span>
          <span className="diff-path" title={file.path}>
            {file.path}
          </span>
          <span className="diff-add">+{file.additions}</span>
          <span className="diff-del">-{file.deletions}</span>
        </button>
        <IconButton
          label={`Copy path ${file.path}`}
          onClick={() => void navigator.clipboard?.writeText(file.path).then(() => pushToast("Path copied"))}
        >
          <Copy size={14} aria-hidden />
        </IconButton>
      </div>
      {open ? <Patch patch={file.patch} find={find} /> : null}
    </li>
  );
}

function DiffOptions() {
  const layout = useUi((state) => state.diffLayout);
  const collapsed = useUi((state) => state.diffFilesCollapsed);
  const ignoreSpace = useUi((state) => state.diffIgnoreWhitespace);
  const hideTests = useUi((state) => state.diffHideTests);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <div className="diff-options">
      <label>
        <input type="checkbox" checked={layout === "split"} onChange={(event) => setPrefs({ diffLayout: event.target.checked ? "split" : "stacked" })} />
        Split
      </label>
      <label>
        <input type="checkbox" checked={collapsed} onChange={(event) => setPrefs({ diffFilesCollapsed: event.target.checked })} />
        Collapse files
      </label>
      <label>
        <input type="checkbox" checked={ignoreSpace} onChange={(event) => setPrefs({ diffIgnoreWhitespace: event.target.checked })} />
        Ignore whitespace
      </label>
      <label>
        <input type="checkbox" checked={hideTests} onChange={(event) => setPrefs({ diffHideTests: event.target.checked })} />
        Hide tests
      </label>
    </div>
  );
}

export function DiffPanel({ threadId }: { threadId: string }) {
  const version = useThreadLogs((state) => state.diffVersion[threadId] ?? 0);
  const [source, setSource] = useState<DiffSource>("worktree");
  const checkpoints = useAsync(`checkpoints:${threadId}`, (signal) =>
    source === "turn" ? api.checkpoints(threadId, signal) : Promise.resolve([]),
  );
  const latestRun = checkpoints.data?.at(-1)?.run_id ?? null;
  const commits = useAsync(`commits:${threadId}:${source}`, (signal) =>
    source === "commit" ? api.commits(threadId, signal) : Promise.resolve([]),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const sha = picked ?? commits.data?.[0]?.sha ?? null;
  const base = useWorkspace((state) => state.threads[threadId]?.worktree?.base ?? "main");
  const scope =
    source === "turn"
      ? latestRun
        ? `turn&run=${encodeURIComponent(latestRun)}`
        : null
      : source === "branch"
        ? `branch&base=${encodeURIComponent(base)}`
        : source === "commit"
          ? sha
            ? `commit&sha=${encodeURIComponent(sha)}`
            : null
          : source;
  const diff = useAsync(`diff:${threadId}:${scope ?? "none"}`, (signal) =>
    scope ? api.diff(threadId, signal, scope) : Promise.resolve([]),
  );
  const { reload } = diff;
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [find, setFind] = useState("");
  const collapsed = useUi((state) => state.diffFilesCollapsed);
  const hideTests = useUi((state) => state.diffHideTests);
  const reveal = useUi((state) => state.diffReveal);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  useEffect(() => {
    if (!reveal) return;
    root.current
      ?.querySelector(`[data-diff-file="${CSS.escape(reveal.path)}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [reveal, diff.data]);

  if (diff.status === "loading") return <Loading label="Loading diff" />;
  if (diff.status === "error" && !diff.data) {
    return <ErrorState title="Couldn't load the diff" failure={diff.error} onRetry={reload} />;
  }
  const all = diff.data ?? [];
  const files = hideTests ? all.filter((file) => !TEST_FILE.test(file.path)) : all;
  const needle = find.trim().toLowerCase();
  const hits = needle
    ? files.reduce((sum, file) => sum + parsePatch(file.patch).filter((line) => line.text.toLowerCase().includes(needle)).length, 0)
    : 0;
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div ref={root}>
      <div className="diff-sources segment" role="radiogroup" aria-label="Diff source">
        {DIFF_SOURCES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={source === entry.id}
            onClick={() => setSource(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {source === "commit" ? (
        <select
          className="diff-commit"
          aria-label="Commit"
          value={sha ?? ""}
          onChange={(event) => setPicked(event.target.value)}
        >
          {(commits.data ?? []).map((commit) => (
            <option key={commit.sha} value={commit.sha}>
              {commit.subject}
            </option>
          ))}
        </select>
      ) : null}
      <DiffOptions />
      <div className="diff-find">
        <input
          type="search"
          aria-label="Find in diff"
          placeholder="Find in diff"
          value={find}
          onChange={(event) => setFind(event.target.value)}
        />
        {needle ? <output>{hits === 1 ? "1 match" : `${hits} matches`}</output> : null}
      </div>
      <div className="panel-bar">
        <span>
          {files.length === 1 ? "1 file" : `${files.length} files`}
          {files.length > 0 ? (
            <>
              {" "}
              <span className="diff-add">+{added}</span> <span className="diff-del">-{removed}</span>
            </>
          ) : null}
        </span>
        <IconButton label="Refresh diff" onClick={reload} disabled={diff.refreshing}>
          <RefreshCw size={16} className={diff.refreshing ? "spin" : undefined} aria-hidden />
        </IconButton>
      </div>
      {diff.status === "error" ? (
        <ErrorState compact title="Couldn't refresh the diff" failure={diff.error} onRetry={reload} />
      ) : null}
      {files.length === 0 ? (
        <Empty title="No changes" />
      ) : (
        <ul className="diff-files">
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              find={needle}
              open={collapsed === toggled.has(file.path)}
              onToggle={() => {
                const next = new Set(toggled);
                if (!next.delete(file.path)) next.add(file.path);
                setToggled(next);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
