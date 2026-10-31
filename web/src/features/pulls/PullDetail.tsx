import { Check, CircleDashed, ExternalLink, FileDiff, GitMerge, MessageSquare, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { PullCheck } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { Button, IconButton, Pill } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { ErrorState, Loading } from "../../ui/states";
import { Markdown } from "../thread/Markdown";
import { pullsApi } from "./pullsApi";

type Tab = "summary" | "timeline" | "code";

const checkIcon = (check: PullCheck) =>
  check.state === "passing" || check.state === "success" ? (
    <Check size={14} className="tone-success" aria-hidden />
  ) : check.state === "failing" || check.state === "failure" ? (
    <X size={14} className="tone-danger" aria-hidden />
  ) : (
    <CircleDashed size={14} className="tone-warn" aria-hidden />
  );

function Checks({ projectId, number }: { projectId: string; number: number }) {
  const checks = useAsync(`pull-checks:${projectId}:${number}`, (signal) => pullsApi.checks(projectId, number, signal));
  if (checks.status !== "ready" || checks.data.length === 0) return null;
  return (
    <section className="pull-section">
      <h3>Checks</h3>
      <ul className="pull-checks">
        {checks.data.map((check) => (
          <li key={`${check.workflow ?? ""}:${check.name}`}>
            {checkIcon(check)}
            <span>{check.name}</span>
            {check.url ? (
              <a href={check.url} target="_blank" rel="noreferrer" aria-label={`Open ${check.name}`}>
                <ExternalLink size={12} aria-hidden />
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Conversation({ projectId, number }: { projectId: string; number: number }) {
  const conversation = useAsync(`pull-comments:${projectId}:${number}`, (signal) =>
    pullsApi.conversation(projectId, number, signal),
  );
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const comments = useMemo(
    () => [
      ...(conversation.data?.comments ?? []),
      ...(conversation.data?.threads ?? []).flatMap((thread) => thread.comments),
    ],
    [conversation.data],
  );
  const send = async (event: string | null) => {
    setBusy(true);
    try {
      if (event) await pullsApi.review(projectId, number, event, body);
      else await pullsApi.comment(projectId, number, body);
      setBody("");
      conversation.reload();
    } catch (failure) {
      pushToast(`Couldn't send that. ${toFailure(failure).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pull-section">
      <h3>Conversation</h3>
      {comments.map((comment) => (
        <article key={comment.id} className="pull-comment">
          <header>
            <strong>{comment.author ?? "Unknown"}</strong>
            {comment.created_at ? <time>{relativeTime(comment.created_at)}</time> : null}
          </header>
          <Markdown text={comment.body} />
        </article>
      ))}
      <textarea
        aria-label="Leave a comment"
        placeholder="Leave a comment"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="pull-form-actions">
        <Button small disabled={busy || !body.trim()} onClick={() => void send(null)}>
          Comment
        </Button>
        <Button small disabled={busy} onClick={() => void send("approve")}>
          Approve
        </Button>
        <Button small disabled={busy || !body.trim()} onClick={() => void send("request_changes")}>
          Request changes
        </Button>
      </div>
    </section>
  );
}

function Timeline({ projectId, number }: { projectId: string; number: number }) {
  const events = useAsync(`pull-timeline:${projectId}:${number}`, (signal) =>
    pullsApi.timeline(projectId, number, signal),
  );
  if (events.status === "loading") return <Loading label="Loading timeline" rows={4} />;
  if (events.status === "error") {
    return <ErrorState compact title="Couldn't load the timeline" failure={events.error} onRetry={events.reload} />;
  }
  if (events.data.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <ol className="pull-timeline">
      {events.data.map((event) => (
        <li key={event.id}>
          <span className="pull-actor">{event.actor ?? "Someone"}</span> {event.text ?? event.kind}
          {event.created_at ? <time>{relativeTime(event.created_at)}</time> : null}
        </li>
      ))}
    </ol>
  );
}

function Code({ projectId, number }: { projectId: string; number: number }) {
  const files = useAsync(`pull-files:${projectId}:${number}`, (signal) => pullsApi.files(projectId, number, signal));
  if (files.status === "loading") return <Loading label="Loading files" rows={4} />;
  if (files.status === "error") {
    return <ErrorState compact title="Couldn't load the files" failure={files.error} onRetry={files.reload} />;
  }
  return (
    <div className="pull-files">
      {files.data.map((file) => (
        <details key={file.path} open={files.data.length <= 5}>
          <summary>
            <FileDiff size={14} aria-hidden />
            <span>{file.path}</span>
            <span className="diff-add">+{file.additions}</span>
            <span className="diff-del">-{file.deletions}</span>
          </summary>
          <pre tabIndex={0}>{file.patch ?? "No diff available"}</pre>
        </details>
      ))}
    </div>
  );
}

/** One pull request: Summary, Timeline and Code, with merge and review. */
export function PullDetail({
  projectId,
  number,
  onClose,
}: {
  projectId: string;
  number: number;
  onClose?(): void;
}) {
  const detail = useAsync(`pull:${projectId}:${number}`, (signal) => pullsApi.detail(projectId, number, signal));
  const [tab, setTab] = useState<Tab>("summary");
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState("squash");
  const pushToast = useUi((state) => state.pushToast);
  const putThread = useWorkspace((state) => state.refreshAll);

  if (detail.status === "loading") return <Loading label="Loading pull request" rows={5} />;
  if (detail.status === "error") {
    return <ErrorState title="Couldn't load this pull request" failure={detail.error} onRetry={detail.reload} />;
  }
  const { pull, body, mergeable, additions, deletions, changed_files: files } = detail.data;
  const open = pull.state === "open";
  const act = async (action: string, done: string) => {
    try {
      await pullsApi.action(projectId, number, action);
      pushToast(done);
      detail.reload();
    } catch (failure) {
      pushToast(`Couldn't do that. ${toFailure(failure).message}`);
    }
  };
  const work = async () => {
    try {
      const thread = await pullsApi.work(projectId, number);
      await putThread();
      navigate({ name: "thread", id: thread.id });
    } catch (failure) {
      pushToast(`Couldn't start a thread. ${toFailure(failure).message}`);
    }
  };

  return (
    <article className="pull-detail" aria-label={pull.title}>
      <header className="pull-detail-head">
        <div>
          <h2>{pull.title}</h2>
          <p>
            <Pill tone={open ? "info" : pull.state === "merged" ? "accent" : "neutral"}>
              {pull.draft ? "Draft" : pull.state}
            </Pill>{" "}
            #{pull.number} · {pull.head} into {pull.base}
            {additions !== null ? ` · +${additions} -${deletions ?? 0}, ${files ?? 0} files` : ""}
          </p>
        </div>
        <span className="pull-detail-actions">
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
            {body ? <Markdown text={body} /> : <p className="muted">No description provided.</p>}
            <Checks projectId={projectId} number={number} />
            <Conversation projectId={projectId} number={number} />
          </>
        ) : tab === "timeline" ? (
          <Timeline projectId={projectId} number={number} />
        ) : (
          <Code projectId={projectId} number={number} />
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
      {merging ? (
        <ConfirmDialog
          title={`Merge #${pull.number}?`}
          confirmLabel="Merge"
          onClose={() => setMerging(false)}
          onConfirm={async () => {
            await pullsApi.merge(projectId, number, method, true);
            detail.reload();
          }}
        >
          <select aria-label="Merge method" value={method} onChange={(event) => setMethod(event.target.value)}>
            <option value="squash">Squash and merge</option>
            <option value="merge">Create a merge commit</option>
            <option value="rebase">Rebase and merge</option>
          </select>
        </ConfirmDialog>
      ) : null}
    </article>
  );
}
