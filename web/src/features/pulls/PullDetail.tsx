import { Check, CircleDashed, EllipsisVertical, ExternalLink, GitMerge, Layers, MessageSquare, Pencil, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { PullCheck, PullRequestDetail } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, Field, IconButton, Pill } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ErrorState, Loading } from "../../ui/states";
import { Markdown } from "../thread/Markdown";
import { PullCode } from "./PullCode";
import { PullConversation } from "./PullConversation";
import { pullsApi } from "./pullsApi";

type Tab = "summary" | "timeline" | "code";

const checkIcon = (check: PullCheck) =>
  check.state === "pass" ? (
    <Check size={14} className="tone-success" role="img" aria-label="Passing" />
  ) : check.state === "fail" ? (
    <X size={14} className="tone-danger" role="img" aria-label="Failing" />
  ) : (
    <CircleDashed size={14} className="tone-warn" role="img" aria-label="Pending" />
  );

/** A fork's workflow waits for approval on a run named only by its link. */
const waitingRun = (check: PullCheck): number | null => {
  if (check.state !== "pending" || !/approv/i.test(check.description ?? "")) return null;
  const run = /\/actions\/runs\/(\d+)/.exec(check.url ?? "");
  return run ? Number(run[1]) : null;
};

function Checks({ projectId, number }: { projectId: string; number: number }) {
  const checks = useAsync(`pull-checks:${projectId}:${number}`, (signal) => pullsApi.checks(projectId, number, signal));
  const pushToast = useUi((state) => state.pushToast);
  if (checks.status !== "ready" || checks.data.length === 0) return null;
  const approve = (run: number) => {
    pullsApi.approveWorkflow(projectId, run).then(
      () => {
        pushToast("Workflow approved");
        checks.reload();
      },
      (failure: unknown) => pushToast(`Couldn't approve it. ${toFailure(failure).message}`),
    );
  };
  return (
    <section className="pull-section">
      <h3>Checks</h3>
      <ul className="pull-checks">
        {checks.data.map((check) => {
          const run = waitingRun(check);
          return (
            <li key={`${check.workflow ?? ""}:${check.name}`}>
              {checkIcon(check)}
              <span>{check.name}</span>
              {check.description ? <small className="muted">{check.description}</small> : null}
              {check.url ? (
                <a href={check.url} target="_blank" rel="noreferrer" aria-label={`Open ${check.name}`}>
                  <ExternalLink size={12} aria-hidden />
                </a>
              ) : null}
              {run !== null ? (
                <Button small onClick={() => approve(run)}>
                  Approve workflow
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Reviewers or labels: what's set, and a search over what the forge offers. */
function People({
  title,
  chosen,
  load,
  save,
}: {
  title: string;
  chosen: string[];
  load(signal: AbortSignal): Promise<{ name: string }[]>;
  save(add: string[], remove: string[]): Promise<void>;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const candidates = useAsync(`pull-${title}`, load);
  const pushToast = useUi((state) => state.pushToast);
  const change = (add: string[], remove: string[]) => {
    save(add, remove).catch((failure: unknown) => pushToast(`Couldn't change that. ${toFailure(failure).message}`));
  };
  const items: MenuItem[] = (candidates.data ?? []).map((candidate) => {
    const on = chosen.includes(candidate.name);
    return {
      label: candidate.name,
      selected: on,
      onSelect: () => (on ? change([], [candidate.name]) : change([candidate.name], [])),
    };
  });
  return (
    <div className="pull-people">
      <span className="muted">{title}</span>
      {chosen.map((name) => (
        <Pill key={name}>{name}</Pill>
      ))}
      <IconButton
        label={`Change ${title.toLowerCase()}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <Plus size={14} aria-hidden />
      </IconButton>
      {menu ? <Menu x={menu.x} y={menu.y} label={title} items={items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function Description({ detail, onSave }: { detail: PullRequestDetail; onSave(body: string): Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <div className="pull-section">
        <textarea aria-label="Description" rows={6} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <div className="pull-form-actions">
          <Button small onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <Button small tone="primary" onClick={() => void onSave(draft).then(() => setDraft(null))}>
            Save description
          </Button>
        </div>
      </div>
    );
  }
  return (
    <>
      {detail.body ? <Markdown text={detail.body} /> : <p className="muted">No description provided.</p>}
      <IconButton label="Edit description" onClick={() => setDraft(detail.body)}>
        <Pencil size={14} aria-hidden />
      </IconButton>
    </>
  );
}

function Timeline({ projectId, number }: { projectId: string; number: number }) {
  const events = useAsync(`pull-timeline:${projectId}:${number}`, (signal) =>
    pullsApi.timeline(projectId, number, signal),
  );
  const [kind, setKind] = useState("all");
  const kinds = useMemo(() => [...new Set((events.data ?? []).map((event) => event.kind))].sort(), [events.data]);
  if (events.status === "loading") return <Loading label="Loading timeline" rows={4} />;
  if (events.status === "error") {
    return <ErrorState compact title="Couldn't load the timeline" failure={events.error} onRetry={events.reload} />;
  }
  if (events.data.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <>
      <select aria-label="Filter activity" value={kind} onChange={(event) => setKind(event.target.value)}>
        <option value="all">All activity</option>
        {kinds.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
      <ol className="pull-timeline">
        {events.data
          .filter((event) => kind === "all" || event.kind === kind)
          .map((event) => (
            <li key={event.id}>
              <span className="pull-actor">{event.actor ?? "Someone"}</span> {event.text ?? event.kind}
              {event.created_at ? <time>{relativeTime(event.created_at)}</time> : null}
            </li>
          ))}
      </ol>
    </>
  );
}

function MergeDialog({
  projectId,
  detail,
  onClose,
  onMerged,
}: {
  projectId: string;
  detail: PullRequestDetail;
  onClose(): void;
  onMerged(): void;
}) {
  const { number } = detail.pull;
  const [method, setMethod] = useState("squash");
  const [auto, setAuto] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [strip, setStrip] = useState(false);
  const [body, setBody] = useState(detail.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      await pullsApi.merge(projectId, number, {
        method,
        auto,
        delete_branch: deleteBranch,
        strip_credits: strip,
        ...(method === "rebase" ? {} : { body }),
      });
      onMerged();
      onClose();
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Merge #${number}?`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone="primary" busy={busy} onClick={() => void merge()}>
            {auto ? "Enable auto-merge" : "Merge"}
          </Button>
        </>
      }
    >
      <Field label="Merge method">
        {(props) => (
          <select {...props} value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="squash">Squash and merge</option>
            <option value="merge">Create a merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
        )}
      </Field>
      {method === "rebase" ? null : (
        <Field label="Commit message">
          {(props) => <textarea {...props} rows={4} value={body} onChange={(event) => setBody(event.target.value)} />}
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
        <span>Merge when checks pass</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} />
        <span>Delete the branch</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={strip} onChange={(event) => setStrip(event.target.checked)} />
        <span>Remove agent credits</span>
      </label>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Where this pull request sits among the ones stacked on each other. */
function Stack({ projectId, number, onOpen }: { projectId: string; number: number; onOpen?(number: number): void }) {
  const stack = useAsync(`pull-stack:${projectId}:${number}`, (signal) => pullsApi.stack(projectId, number, signal));
  const [method, setMethod] = useState("squash");
  const pushToast = useUi((state) => state.pushToast);
  if (!stack.data || stack.data.layers.length < 2) return null;
  const { layers, position } = stack.data;
  const act = (action: string) => {
    pullsApi.stackAction(projectId, number, action, action === "merge" ? method : undefined).then(
      (results) => {
        const failed = results.find((result) => !result.ok);
        pushToast(failed ? `Stopped at #${failed.number}. ${failed.message ?? ""}` : "Stack updated");
        stack.reload();
      },
      (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`),
    );
  };
  return (
    <nav className="pull-stack" aria-label="Stack">
      <Layers size={14} aria-hidden />
      <span>
        {position + 1} of {layers.length}
      </span>
      {layers.map((layer) => (
        <button
          type="button"
          key={layer.number}
          aria-current={layer.number === number ? "true" : undefined}
          onClick={() => onOpen?.(layer.number)}
        >
          #{layer.number}
        </button>
      ))}
      <select aria-label="Stack merge method" value={method} onChange={(event) => setMethod(event.target.value)}>
        <option value="squash">Squash</option>
        <option value="merge">Merge</option>
        <option value="rebase">Rebase</option>
      </select>
      <Button small onClick={() => act("merge")}>
        Merge stack
      </Button>
      <Button small onClick={() => act("rebase")}>
        Rebase stack
      </Button>
    </nav>
  );
}

/** One pull request: Summary, Timeline and Code, with merge and review. */
export function PullDetail({
  projectId,
  number,
  onClose,
  onOpen,
}: {
  projectId: string;
  number: number;
  onClose?(): void;
  /** Moves to another pull request in the same stack. */
  onOpen?(number: number): void;
}) {
  const detail = useAsync(`pull:${projectId}:${number}`, (signal) => pullsApi.detail(projectId, number, signal));
  const [tab, setTab] = useState<Tab>("summary");
  const [merging, setMerging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const refreshAll = useWorkspace((state) => state.refreshAll);
  const engines = useWorkspace((state) => state.engines.data);

  if (detail.status === "loading") return <Loading label="Loading pull request" rows={5} />;
  if (detail.status === "error") {
    return <ErrorState title="Couldn't load this pull request" failure={detail.error} onRetry={detail.reload} />;
  }
  const { pull, mergeable, additions, deletions, changed_files: files } = detail.data;
  const open = pull.state === "open";
  const run = async (work: Promise<unknown>, done: string) => {
    try {
      await work;
      pushToast(done);
      detail.reload();
    } catch (failure) {
      pushToast(`Couldn't do that. ${toFailure(failure).message}`);
    }
  };
  const update = (change: Parameters<typeof pullsApi.update>[2], done: string) => run(pullsApi.update(projectId, number, change), done);
  const act = (action: string, done: string) => run(pullsApi.action(projectId, number, action), done);
  const engine = engines?.find((entry) => entry.installed)?.id;
  const work = async () => {
    if (!engine) {
      pushToast("Install an engine first.");
      return;
    }
    try {
      const thread = await pullsApi.work(projectId, number, engine);
      await refreshAll();
      navigate({ name: "thread", id: thread.id });
    } catch (failure) {
      pushToast(`Couldn't start a thread. ${toFailure(failure).message}`);
    }
  };
  const checkout = async (worktree: boolean) => {
    try {
      const done = await pullsApi.checkout(projectId, number, worktree);
      pushToast(done.warning ?? `Checked out ${done.branch}`);
    } catch (failure) {
      pushToast(`Couldn't check it out. ${toFailure(failure).message}`);
    }
  };
  const items: MenuItem[] = [
    ...(open
      ? [
          pull.draft
            ? { label: "Ready for review", onSelect: () => void update({ draft: false }, "Ready for review") }
            : { label: "Convert to draft", onSelect: () => void update({ draft: true }, "Converted to draft") },
          { label: "Update branch", onSelect: () => void act("update_branch", "Branch updated") },
          { label: "Update with rebase", onSelect: () => void act("rebase", "Branch rebased") },
          {
            label: detail.data.maintainer_can_modify ? "Stop maintainer edits" : "Allow maintainer edits",
            onSelect: () =>
              void update({ maintainer_can_modify: !detail.data.maintainer_can_modify }, "Maintainer edits changed"),
          },
        ]
      : []),
    { label: "Check out here", separatorBefore: true, onSelect: () => void checkout(false) },
    { label: "Check out in a worktree", onSelect: () => void checkout(true) },
    ...(pull.state === "merged"
      ? [{ label: "Revert changes", onSelect: () => void act("revert", "Revert opened") }]
      : []),
    {
      label: "Delete branch",
      destructive: true,
      separatorBefore: true,
      onSelect: () => void act("delete_branch", "Branch deleted"),
    },
  ];

  return (
    <article className="pull-detail" aria-label={pull.title}>
      <header className="pull-detail-head">
        <div>
          {editing !== null ? (
            <form
              className="pull-title-form"
              onSubmit={(event) => {
                event.preventDefault();
                void update({ title: editing }, "Title saved").then(() => setEditing(null));
              }}
            >
              <input aria-label="Title" value={editing} autoFocus onChange={(event) => setEditing(event.target.value)} />
              <Button small tone="primary" type="submit" disabled={!editing.trim()}>
                Save
              </Button>
              <Button small onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <h2>
              {pull.title}{" "}
              <IconButton label="Edit title" onClick={() => setEditing(pull.title)}>
                <Pencil size={12} aria-hidden />
              </IconButton>
            </h2>
          )}
          <p>
            <Pill tone={open ? "info" : pull.state === "merged" ? "accent" : "neutral"}>
              {pull.draft ? "Draft" : pull.state}
            </Pill>{" "}
            #{pull.number} · {pull.head} into{" "}
            {open ? (
              <input
                className="pull-base"
                aria-label="Base branch"
                defaultValue={pull.base}
                key={pull.base}
                onBlur={(event) => {
                  const base = event.target.value.trim();
                  if (base && base !== pull.base) void update({ base }, "Base branch changed");
                }}
              />
            ) : (
              pull.base
            )}
            {additions !== null ? ` · +${additions} -${deletions ?? 0}, ${files ?? 0} files` : ""}
            {detail.data.auto_merge ? " · Merges when checks pass" : ""}
          </p>
        </div>
        <span className="pull-detail-actions">
          <IconButton
            label="More actions"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <EllipsisVertical size={14} aria-hidden />
          </IconButton>
          <a className="icon-btn" href={pull.url} target="_blank" rel="noreferrer" aria-label="Open on the forge">
            <ExternalLink size={14} aria-hidden />
          </a>
          {onClose ? (
            <IconButton label="Close pull request" onClick={onClose}>
              <X size={14} aria-hidden />
            </IconButton>
          ) : null}
        </span>
      </header>
      <Stack projectId={projectId} number={number} onOpen={onOpen} />
      <div className="pull-tabs segment" role="tablist" aria-label="Pull request">
        {(["summary", "timeline", "code"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-checked={tab === entry}
            aria-selected={tab === entry}
            onClick={() => setTab(entry)}
          >
            {entry === "summary" ? "Summary" : entry === "timeline" ? "Timeline" : "Code"}
          </button>
        ))}
      </div>
      <div className="pull-body">
        {tab === "summary" ? (
          <>
            <Description detail={detail.data} onSave={(body) => update({ body }, "Description saved")} />
            <People
              title="Reviewers"
              chosen={detail.data.reviewers}
              load={(signal) => pullsApi.reviewerCandidates(projectId, signal)}
              save={(add, remove) => pullsApi.setReviewers(projectId, number, add, remove).then(detail.reload)}
            />
            <People
              title="Labels"
              chosen={pull.labels}
              load={(signal) => pullsApi.labelCandidates(projectId, signal)}
              save={(add, remove) => pullsApi.setLabels(projectId, number, add, remove).then(detail.reload)}
            />
            <Checks projectId={projectId} number={number} />
            <PullConversation projectId={projectId} number={number} />
          </>
        ) : tab === "timeline" ? (
          <Timeline projectId={projectId} number={number} />
        ) : (
          <PullCode projectId={projectId} number={number} onReviewed={detail.reload} />
        )}
      </div>
      <footer className="pull-foot">
        <Button small icon={<MessageSquare size={14} aria-hidden />} onClick={() => void work()}>
          Work on this
        </Button>
        {open ? (
          <>
            <Button small onClick={() => void act("close", "Closed")}>
              Close
            </Button>
            <Button
              small
              tone="primary"
              icon={<GitMerge size={14} aria-hidden />}
              disabled={mergeable === "conflicting"}
              onClick={() => setMerging(true)}
            >
              Merge
            </Button>
          </>
        ) : pull.state === "closed" ? (
          <Button small onClick={() => void act("reopen", "Reopened")}>
            Reopen
          </Button>
        ) : null}
      </footer>
      {merging ? <MergeDialog projectId={projectId} detail={detail.data} onClose={() => setMerging(false)} onMerged={detail.reload} /> : null}
      {menu ? <Menu x={menu.x} y={menu.y} label="Pull request actions" items={items} onClose={() => setMenu(null)} /> : null}
    </article>
  );
}

