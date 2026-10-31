import { Check, CornerDownRight, Pencil, SmilePlus } from "lucide-react";
import { useMemo, useState } from "react";
import type { PullComment, PullThread } from "../../api/types";
import { relativeTime } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { Markdown } from "../thread/Markdown";
import { pullsApi } from "./pullsApi";

const REACTIONS: [string, string][] = [
  ["+1", "👍"],
  ["-1", "👎"],
  ["laugh", "😄"],
  ["hooray", "🎉"],
  ["confused", "😕"],
  ["heart", "❤️"],
  ["rocket", "🚀"],
  ["eyes", "👀"],
];

function Comment({
  projectId,
  number,
  comment,
  onChanged,
}: {
  projectId: string;
  number: number;
  comment: PullComment;
  onChanged(): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const save = async () => {
    try {
      await pullsApi.editComment(projectId, number, comment.id, comment.kind, draft ?? "");
      setDraft(null);
      onChanged();
    } catch (failure) {
      pushToast(`Couldn't save that. ${toFailure(failure).message}`);
    }
  };
  const react = (content: string) => {
    pullsApi.react(projectId, number, comment.id, comment.kind, content).then(
      () => pushToast("Reaction added"),
      (failure: unknown) => pushToast(`Couldn't react. ${toFailure(failure).message}`),
    );
  };
  return (
    <article className="pull-comment" aria-label={`Comment by ${comment.author ?? "someone"}`}>
      <header>
        <strong>{comment.author ?? "Unknown"}</strong>
        {comment.created_at ? <time>{relativeTime(comment.created_at)}</time> : null}
        <span className="pull-comment-actions">
          <IconButton
            label="React"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            <SmilePlus size={14} aria-hidden />
          </IconButton>
          <IconButton label="Edit comment" onClick={() => setDraft(comment.body)}>
            <Pencil size={14} aria-hidden />
          </IconButton>
        </span>
      </header>
      {draft === null ? (
        <Markdown text={comment.body} />
      ) : (
        <>
          <textarea aria-label="Edit comment text" rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="pull-form-actions">
            <Button small onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button small tone="primary" disabled={!draft.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </>
      )}
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          label="Reactions"
          items={REACTIONS.map(([content, emoji]) => ({ label: `${emoji} ${content}`, onSelect: () => react(content) }))}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </article>
  );
}

function Thread({
  projectId,
  number,
  thread,
  onChanged,
}: {
  projectId: string;
  number: number;
  thread: PullThread;
  onChanged(): void;
}) {
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(!thread.resolved);
  const pushToast = useUi((state) => state.pushToast);
  const act = (work: Promise<void>, failed: string) => {
    work.then(onChanged, (failure: unknown) => pushToast(`${failed} ${toFailure(failure).message}`));
  };
  const first = thread.comments[0];
  return (
    <details className="pull-thread" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span>
          {thread.path ?? "Conversation"}
          {thread.line ? `:${thread.line}` : ""}
        </span>
        {thread.resolved ? <small>Resolved</small> : null}
      </summary>
      {thread.comments.map((comment) => (
        <Comment key={comment.id} projectId={projectId} number={number} comment={comment} onChanged={onChanged} />
      ))}
      <textarea aria-label={`Reply on ${thread.path ?? "conversation"}`} placeholder="Reply" rows={2} value={reply} onChange={(event) => setReply(event.target.value)} />
      <div className="pull-form-actions">
        <Button
          small
          icon={<CornerDownRight size={14} aria-hidden />}
          disabled={!reply.trim() || !first}
          onClick={() => {
            act(
              pullsApi.comment(projectId, number, reply, first?.id).then(() => setReply("")),
              "Couldn't reply.",
            );
          }}
        >
          Reply
        </Button>
        <Button
          small
          icon={<Check size={14} aria-hidden />}
          onClick={() => act(pullsApi.resolve(projectId, number, thread.id, !thread.resolved), "Couldn't change that.")}
        >
          {thread.resolved ? "Unresolve" : "Resolve"}
        </Button>
      </div>
    </details>
  );
}

/** Comments and line threads, with the review form at the end. */
export function PullConversation({ projectId, number }: { projectId: string; number: number }) {
  const conversation = useAsync(`pull-comments:${projectId}:${number}`, (signal) =>
    pullsApi.conversation(projectId, number, signal),
  );
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const comments = useMemo(() => conversation.data?.comments ?? [], [conversation.data]);
  const threads = conversation.data?.threads ?? [];
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
        <Comment key={comment.id} projectId={projectId} number={number} comment={comment} onChanged={conversation.reload} />
      ))}
      {threads.map((thread) => (
        <Thread key={thread.id} projectId={projectId} number={number} thread={thread} onChanged={conversation.reload} />
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
