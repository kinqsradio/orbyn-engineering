import { ChevronRight, Copy, GitPullRequest, MessageSquare, RefreshCw, Undo2 } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { FileDiff } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { pullsApi } from "../../api/pulls";
import { useWorkspace } from "../../state/workspace";
import { useThreadLogs } from "../thread/threadLogs";
import { useUi } from "../../state/ui";
import { useComposerChips } from "../thread/composerChipStore";
import { CHIP_EXCERPT_LIMIT, charactersOver, chipId, chipLabel, promptWithChips, type ReviewChip } from "../thread/composerContext";
import { Button, IconButton } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { RestoreFilesDialog } from "../thread/MessageActions";
import { GitActionDialog, createPullRequestPlan, useGitAvailable } from "../thread/GitControl";
import { useResolvedThreadPath } from "../thread/useResolvedThreadPath";

const LINE_LIMIT = 2000;
/** A large diff renders files in pages, so a huge change set never mounts at once. */
const FILE_PAGE = 50;
const PAGE_LINES = 4000;

/** Where the page that starts at `from` ends: 50 files or about 4,000 patch lines, at least one file. */
export function nextPageEnd(files: readonly { patch: string }[], from: number): number {
  let lines = 0;
  let at = from;
  while (at < files.length && at - from < FILE_PAGE) {
    lines += files[at]!.patch.split("\n").length;
    if (at > from && lines > PAGE_LINES) break;
    at += 1;
  }
  return at;
}

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

/**
 * The new-side line number each line lands on. A hunk header resets the count;
 * removed lines take no new number, and metadata has none.
 */
export function numberedLines(lines: readonly DiffLine[]): { line: DiffLine; number: number | null }[] {
  let next = 0;
  return lines.map((line) => {
    if (line.kind === "hunk") {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line.text);
      next = match?.[1] ? Number(match[1]) : 0;
      return { line, number: null };
    }
    if (line.kind === "add" || line.kind === "ctx") {
      const number = next > 0 ? next : null;
      if (next > 0) next += 1;
      return { line, number };
    }
    return { line, number: null };
  });
}

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

type Numbered = { line: DiffLine; number: number | null };

/** Pairs each run of removals with the additions after it, keeping new-side numbers. */
export function splitNumbered(entries: readonly Numbered[]): { left: Numbered | null; right: Numbered | null }[] {
  const rows: { left: Numbered | null; right: Numbered | null }[] = [];
  let removed: Numbered[] = [];
  let added: Numbered[] = [];
  const flush = () => {
    for (let at = 0; at < Math.max(removed.length, added.length); at += 1) {
      rows.push({ left: removed[at] ?? null, right: added[at] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const entry of entries) {
    if (entry.line.kind === "del") {
      if (added.length > 0) flush();
      removed.push(entry);
    } else if (entry.line.kind === "add") {
      added.push(entry);
    } else {
      flush();
      rows.push({ left: entry, right: entry });
    }
  }
  flush();
  return rows;
}

/** Pairs each run of removals with the additions after it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  return splitNumbered(lines.map((line) => ({ line, number: null }))).map((row) => ({
    left: row.left?.line ?? null,
    right: row.right?.line ?? null,
  }));
}

/**
 * The new-side text a diff comment covers: the added and unchanged lines from
 * `start` to `end`, as shown. Removed lines have no new number and stay out.
 */
export function diffCommentRange(entries: readonly Numbered[], start: number, end: number) {
  const line = Math.min(start, end);
  const endLine = Math.max(start, end);
  const covered = entries.filter((entry) => entry.number !== null && entry.number >= line && entry.number <= endLine);
  if (covered.length === 0) return null;
  const excerpt = covered.map((entry) => entry.line.text.slice(1)).join("\n");
  if (excerpt.length > CHIP_EXCERPT_LIMIT) return null;
  return { line, endLine, excerpt };
}

function LineCell({ line, find, number, selected, onComment }: {
  line: DiffLine | null; find: string; number?: number | null; selected?: boolean; onComment?(shift: boolean): void;
}) {
  if (!line) return <div className="patch-line patch-empty"> </div>;
  const marker = markers[line.kind];
  const hit = find !== "" && line.text.toLowerCase().includes(find);
  return (
    <div className={`patch-line patch-${line.kind}`} data-hit={hit || undefined} data-selected={selected || undefined}>
      {marker ? <span className="sr-only">{marker}: </span> : null}
      {line.text || " "}
      {onComment && number ? (
        <button
          type="button"
          className="patch-line-number"
          aria-label={`Comment on line ${number}`}
          aria-pressed={Boolean(selected)}
          onClick={(event) => onComment(event.shiftKey)}
        >
          <MessageSquare size={12} aria-hidden />
          {number}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A diff comment is a review chip: the composer owns it, and the patch shows it
 * under the line it ends on for as long as the chip exists. Removing either
 * removes both. `origin` ties it to this diff view, as a file comment is tied
 * to the source it was made on.
 */
function Patch({ patch, find, path, threadId, origin }: {
  patch: string; find: string; path: string; threadId: string; origin: string;
}) {
  const ignoreSpace = useUi((state) => state.diffIgnoreWhitespace);
  const layout = useUi((state) => state.diffLayout);
  const pushToast = useUi((state) => state.pushToast);
  const cwd = useWorkspace((state) => state.threads[threadId]?.cwd);
  const chips = useComposerChips((state) => state.chips[threadId]);
  const lines = useMemo(() => {
    const parsed = parsePatch(patch);
    return ignoreSpace ? withoutWhitespaceChanges(parsed) : parsed;
  }, [patch, ignoreSpace]);
  const [all, setAll] = useState(false);
  const [selection, setSelection] = useState<{ anchor: number; end: number } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const visible = all ? lines : lines.slice(0, LINE_LIMIT);
  const numbered = useMemo(() => numberedLines(visible), [visible]);
  if (lines.length === 0) return <p className="muted diff-binary">No text changes to show.</p>;
  const comments = (chips ?? []).filter((chip): chip is ReviewChip => chip.kind === "review" && chip.path === path
    && chip.sourceRevision === origin && (chip.sourceCwd ?? "") === (cwd ?? ""));
  const low = selection ? Math.min(selection.anchor, selection.end) : 0;
  const high = selection ? Math.max(selection.anchor, selection.end) : 0;
  const range = selection ? diffCommentRange(numbered, selection.anchor, selection.end) : null;
  const cancel = () => { setSelection(null); setText(""); setError(null); };
  const pick = (number: number, shift: boolean) => {
    setSelection((current) => ({ anchor: shift && current ? current.anchor : number, end: number }));
    setError(null);
  };
  const add = () => {
    if (!range || text.trim() === "") return;
    const chip: ReviewChip = {
      id: chipId(), kind: "review", path, ...range, comment: text.trim(), sourceRevision: origin,
      ...(cwd ? { sourceCwd: cwd } : {}),
    };
    if (chip.endLine === chip.line) delete chip.endLine;
    const current = useComposerChips.getState().chips[threadId] ?? [];
    if (charactersOver(promptWithChips(useUi.getState().drafts[threadId] ?? "", [...current, chip]))) {
      setError("This comment would make your message too long. Shorten it before adding it.");
      return;
    }
    useComposerChips.getState().add(threadId, chip);
    pushToast("Review comment added to your message");
    cancel();
  };
  const selected = (number: number | null | undefined) => selection !== null && number != null && number >= low && number <= high;
  const after = (number: number | null | undefined) => {
    if (number == null) return null;
    const here = comments.filter((chip) => (chip.endLine ?? chip.line) === number);
    const form = selection !== null && number === high;
    if (here.length === 0 && !form) return null;
    return (
      <div className="diff-annotations">
        {here.map((chip) => (
          <div key={chip.id} className="diff-comment" role="note" aria-label={`Review comment ${chipLabel(chip)}`}>
            <span className="diff-comment-head">
              <strong>You</strong>
              <span className="diff-comment-where">{chipLabel(chip)}</span>
              <span className="diff-comment-state">Review comment</span>
            </span>
            <p>{chip.comment}</p>
            <Button small tone="quiet" onClick={() => useComposerChips.getState().remove(threadId, chip.id)}>
              Remove comment
            </Button>
          </div>
        ))}
        {form ? (
          <form className="review-comment" onSubmit={(event) => { event.preventDefault(); add(); }}>
            <label htmlFor={`diff-comment-${path}`}>
              Comment on {path}:{low}{high !== low ? `–${high}` : ""}
            </label>
            <textarea
              id={`diff-comment-${path}`}
              aria-label={`Review comment on ${path} line ${low}${high !== low ? `–${high}` : ""}`}
              value={text}
              maxLength={20000}
              autoFocus
              onChange={(event) => setText(event.target.value)}
            />
            {!range ? <p role="alert">Select at most 4,000 characters of the diff for a comment.</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            <div>
              <Button small tone="quiet" onClick={cancel}>Cancel</Button>
              <Button small tone="primary" type="submit" disabled={!range || text.trim() === ""}>Add to message</Button>
            </div>
          </form>
        ) : null}
      </div>
    );
  };
  return (
    <>
      <div className="patch" tabIndex={0} role="group" aria-label="Patch" data-layout={layout}>
        <div className="patch-inner">
          {layout === "split"
            ? splitNumbered(numbered).map((row, at) => (
                <Fragment key={at}>
                  <div className="patch-split">
                    <LineCell line={row.left?.line ?? null} find={find} />
                    <LineCell
                      line={row.right?.line ?? null}
                      find={find}
                      number={row.right?.number}
                      selected={selected(row.right?.number)}
                      onComment={(shift) => row.right?.number && pick(row.right.number, shift)}
                    />
                  </div>
                  {after(row.right?.number)}
                </Fragment>
              ))
            : numbered.map(({ line, number }, at) => (
                <Fragment key={at}>
                  <LineCell
                    line={line}
                    find={find}
                    number={number}
                    selected={selected(number)}
                    onComment={(shift) => number && pick(number, shift)}
                  />
                  {after(number)}
                </Fragment>
              ))}
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

function FileRow({
  file,
  open,
  find,
  threadId,
  origin,
  onToggle,
}: {
  file: FileDiff;
  open: boolean;
  find: string;
  threadId: string;
  origin: string;
  onToggle(): void;
}) {
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
      {open ? <Patch patch={file.patch} find={find} path={file.path} threadId={threadId} origin={origin} /> : null}
    </li>
  );
}

/** Unified or split, the same stored choice as Settings › Diffs. */
function DiffView() {
  const layout = useUi((state) => state.diffLayout);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <div className="diff-view segment" role="radiogroup" aria-label="Diff view">
      {([["stacked", "Unified"], ["split", "Split"]] as const).map(([id, label]) => (
        <button key={id} type="button" role="radio" aria-checked={layout === id} onClick={() => setPrefs({ diffLayout: id })}>
          {label}
        </button>
      ))}
    </div>
  );
}

function DiffOptions() {
  const collapsed = useUi((state) => state.diffFilesCollapsed);
  const ignoreSpace = useUi((state) => state.diffIgnoreWhitespace);
  const hideTests = useUi((state) => state.diffHideTests);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <div className="diff-options">
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

/** A Jujutsu checkout's working-copy change, as the installed `jj` describes it. */
function JjChange({ threadId, version }: { threadId: string; version: number }) {
  const status = useAsync(`jj:${threadId}:${version}`, (signal) => api.jjStatus(threadId, signal));
  if (status.status === "error") {
    return <p className="jj-change" role="note">Jujutsu: {status.error.message}</p>;
  }
  const change = status.data;
  if (!change) return null;
  return (
    <p className="jj-change" role="note" aria-label="Jujutsu change">
      <span>jj change <code>{change.change_id}</code></span>
      <span> commit <code>{change.commit_id}</code></span>
      {change.bookmarks.length > 0 ? <span> on {change.bookmarks.join(", ")}</span> : null}
      <span> · {change.description || "(no description)"}</span>
      {change.conflict ? <span className="diff-del"> · conflicted</span> : null}
    </p>
  );
}

export function DiffPanel({ threadId }: { threadId: string }) {
  const version = useThreadLogs((state) => state.diffVersion[threadId] ?? 0);
  const [source, setSource] = useState<DiffSource>("worktree");
  const checkpoints = useAsync(`checkpoints:${threadId}:${source === "turn" ? version : "off"}`, (signal) =>
    source === "turn" ? api.checkpoints(threadId, signal) : Promise.resolve([]),
  );
  const turns = checkpoints.data ?? [];
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  const latestRun = (pickedRun && turns.some((turn) => turn.run_id === pickedRun) ? pickedRun : turns.at(-1)?.run_id) ?? null;
  const thread = useWorkspace((state) => state.threads[threadId]);
  const linkedPulls = useAsync(`diff-linked:${threadId}`, (signal) => pullsApi.linked(threadId, signal));
  const gitAvailable = useGitAvailable(threadId);
  const canCreate = gitAvailable && linkedPulls.status === "ready" && linkedPulls.data.length === 0;
  const [restoring, setRestoring] = useState(false);
  const [creating, setCreating] = useState(false);
  const commits = useAsync(`commits:${threadId}:${source}`, (signal) =>
    source === "commit" ? api.commits(threadId, signal) : Promise.resolve([]),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const commitReveal = useUi((state) => state.commitReveal);
  useEffect(() => {
    if (!commitReveal) return;
    setSource("commit");
    setPicked(commitReveal.sha);
  }, [commitReveal]);
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
  // Which diff a comment was made on, so it shows only there.
  const origin =
    source === "turn" ? `diff:turn:${latestRun ?? ""}`
      : source === "branch" ? `diff:branch:${base}`
        : source === "commit" ? `diff:commit:${sha ?? ""}`
          : `diff:${source}`;
  const diff = useAsync(`diff:${threadId}:${scope ?? "none"}`, (signal) =>
    scope ? api.diff(threadId, signal, scope) : Promise.resolve([]),
  );
  const { reload } = diff;
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [find, setFind] = useState("");
  const collapsed = useUi((state) => state.diffFilesCollapsed);
  const hideTests = useUi((state) => state.diffHideTests);
  const reveal = useUi((state) => state.diffReveal);
  const resolved = useResolvedThreadPath(threadId, reveal ? { ...reveal, basis: "repository" } : null);
  const consume = useUi((state) => state.consumeDiffReveal);
  const [loaded, setLoaded] = useState(0);
  const shownFiles = useMemo(() => {
    const every = diff.data ?? [];
    return hideTests ? every.filter((file) => !TEST_FILE.test(file.path)) : every;
  }, [diff.data, hideTests]);
  const shownCount = Math.max(loaded, nextPageEnd(shownFiles, 0));
  // A new diff starts again from its first page.
  useEffect(() => setLoaded(0), [scope, hideTests]);
  const root = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!reveal) return;
    if (reveal.threadId !== threadId || useWorkspace.getState().threads[threadId]?.cwd !== reveal.cwd) consume(reveal.nonce);
  }, [reveal, threadId, resolved.key, consume]);

  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  useEffect(() => {
    const path = resolved.value?.repository_path;
    if (!path || !reveal || useUi.getState().diffReveal?.nonce !== reveal.nonce
      || useWorkspace.getState().threads[threadId]?.cwd !== reveal.cwd) return;
    // A file past the loaded pages loads first, then scrolls into view.
    const at = shownFiles.findIndex((file) => file.path === path);
    if (at >= shownCount) { setLoaded(at + 1); return; }
    const target = root.current?.querySelector(`[data-diff-file="${CSS.escape(path)}"]`);
    if (target) { target.scrollIntoView({ block: "start" }); consume(reveal.nonce); }
  }, [reveal, resolved.value, diff.data, consume, threadId, shownFiles, shownCount]);

  // Loading the next page as the end of the list scrolls into view.
  useEffect(() => {
    const sentinel = more.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLoaded((count) => nextPageEnd(shownFiles, Math.max(count, shownCount)));
    }, { rootMargin: "400px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [shownFiles, shownCount]);

  if (diff.status === "loading") return <Loading label="Loading diff" />;
  if (diff.status === "error" && !diff.data) {
    return <ErrorState title="Couldn't load the diff" failure={diff.error} onRetry={reload} />;
  }
  const files = shownFiles;
  const page = files.slice(0, shownCount);
  const needle = find.trim().toLowerCase();
  // Find covers the files loaded so far, and says so while more remain.
  const hits = needle
    ? page.reduce((sum, file) => sum + parsePatch(file.patch).filter((line) => line.text.toLowerCase().includes(needle)).length, 0)
    : 0;
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div ref={root}>
      <JjChange threadId={threadId} version={version} />
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
      <DiffView />
      {source === "turn" && turns.length > 0 ? (
        <select
          className="diff-commit"
          aria-label="Turn"
          value={latestRun ?? ""}
          onChange={(event) => setPickedRun(event.target.value)}
        >
          {turns.map((turn, at) => (
            <option key={turn.run_id} value={turn.run_id}>
              {`Turn ${at + 1} of ${turns.length}`}
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
        {needle && page.length < files.length ? (
          <p className="muted" role="note">Find covers the {page.length} of {files.length} files loaded so far. Scroll to load more.</p>
        ) : null}
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
          {page.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              find={needle}
              threadId={threadId}
              origin={origin}
              open={collapsed === toggled.has(file.path)}
              onToggle={() => {
                const next = new Set(toggled);
                if (!next.delete(file.path)) next.add(file.path);
                setToggled(next);
              }}
            />
          ))}
          {page.length < files.length ? (
            <li ref={more} className="diff-more">
              <Button small tone="quiet" onClick={() => setLoaded(nextPageEnd(files, page.length))}>
                Load more files ({files.length - page.length} left)
              </Button>
            </li>
          ) : null}
        </ul>
      )}
      {thread && thread.active_run === null && ((source === "turn" && latestRun) || canCreate) ? (
        <div className="diff-foot">
          {source === "turn" && latestRun ? (
            <Button small tone="quiet" icon={<Undo2 size={14} aria-hidden />} onClick={() => setRestoring(true)}>
              Restore files to before this response
            </Button>
          ) : null}
          {canCreate ? (
            <Button small tone="quiet" icon={<GitPullRequest size={14} aria-hidden />} onClick={() => setCreating(true)}>
              Create pull request
            </Button>
          ) : null}
        </div>
      ) : null}
      {restoring && latestRun ? <RestoreFilesDialog threadId={threadId} runId={latestRun} onClose={() => setRestoring(false)} /> : null}
      {creating && thread ? <GitActionDialog thread={thread} plan={createPullRequestPlan()} onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
