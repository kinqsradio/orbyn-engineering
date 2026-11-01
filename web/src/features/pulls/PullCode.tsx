import { FileDiff, MessageSquarePlus, X } from "lucide-react";
import { useState } from "react";
import type { PullFile, ReviewLineComment } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { pullsApi } from "./pullsApi";

interface PatchLine {
  text: string;
  /** The line in the new file, for lines that have one. */
  line: number | null;
}

/** Numbers a unified patch by the new file, which is where a review comment lands. */
export function numberedPatch(patch: string): PatchLine[] {
  let next = 0;
  return patch.split("\n").map((text) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      next = Number(hunk[1]);
      return { text, line: null };
    }
    if (text.startsWith("-")) return { text, line: null };
    const line = next;
    next += 1;
    return { text, line };
  });
}

function FileRow({
  file,
  open,
  drafts,
  readOnly = false,
  onViewed,
  onDraft,
}: {
  file: PullFile;
  open: boolean;
  drafts: ReviewLineComment[];
  /** A single commit: comments and viewed marks belong to the whole pull request. */
  readOnly?: boolean;
  onViewed(viewed: boolean): void;
  onDraft(comment: ReviewLineComment | { path: string; line: number; body: null }): void;
}) {
  const [writing, setWriting] = useState<{ line: number; text: string } | null>(null);
  return (
    <details open={open && !file.viewed}>
      <summary>
        <FileDiff size={14} aria-hidden />
        <span>{file.path}</span>
        <span className="diff-add">+{file.additions}</span>
        <span className="diff-del">-{file.deletions}</span>
        {readOnly ? null : (
          <label className="pull-viewed" onClick={(event) => event.stopPropagation()}>
            <input type="checkbox" aria-label={`Viewed ${file.path}`} checked={file.viewed} onChange={(event) => onViewed(event.target.checked)} />
            Viewed
          </label>
        )}
      </summary>
      {file.patch ? (
        <div className="pull-patch" role="table" aria-label={`Changes in ${file.path}`}>
          {numberedPatch(file.patch).map((row, at) => {
            const kind = row.text.startsWith("+") ? "add" : row.text.startsWith("-") ? "del" : row.text.startsWith("@@") ? "hunk" : "";
            const held = row.line === null ? undefined : drafts.find((draft) => draft.line === row.line);
            return (
              <div key={at}>
                <div className="pull-patch-row" role="row" data-kind={kind || undefined}>
                  {row.line !== null && !readOnly ? (
                    <IconButton label={`Comment on line ${row.line} of ${file.path}`} onClick={() => setWriting({ line: row.line ?? 0, text: "" })}>
                      <MessageSquarePlus size={12} aria-hidden />
                    </IconButton>
                  ) : (
                    <span className="pull-patch-gap" />
                  )}
                  <code>{row.text}</code>
                </div>
                {held ? (
                  <div className="pull-draft">
                    <span>{held.body}</span>
                    <IconButton label={`Discard comment on line ${held.line}`} onClick={() => onDraft({ path: file.path, line: held.line, body: null })}>
                      <X size={12} aria-hidden />
                    </IconButton>
                  </div>
                ) : null}
                {writing && writing.line === row.line ? (
                  <div className="pull-draft-form">
                    <textarea
                      aria-label={`Comment for line ${writing.line}`}
                      rows={2}
                      autoFocus
                      value={writing.text}
                      onChange={(event) => setWriting({ ...writing, text: event.target.value })}
                    />
                    <div className="pull-form-actions">
                      <Button small onClick={() => setWriting(null)}>
                        Cancel
                      </Button>
                      <Button
                        small
                        tone="primary"
                        disabled={!writing.text.trim()}
                        onClick={() => {
                          onDraft({ path: file.path, line: writing.line, body: writing.text });
                          setWriting(null);
                        }}
                      >
                        Add to review
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted">No diff available</p>
      )}
    </details>
  );
}

/** The changed files, marks of what's been read, and comments held for one review. */
export function PullCode({ projectId, number, onReviewed }: { projectId: string; number: number; onReviewed(): void }) {
  const [revision, setRevision] = useState("");
  const revisions = useAsync(`pull-revisions:${projectId}:${number}`, (signal) => pullsApi.revisions(projectId, number, signal));
  const files = useAsync(`pull-files:${projectId}:${number}:${revision}`, (signal) =>
    revision ? pullsApi.commitFiles(projectId, revision, signal) : pullsApi.files(projectId, number, signal),
  );
  const [drafts, setDrafts] = useState<ReviewLineComment[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  if (files.status === "loading") return <Loading label="Loading files" rows={4} />;
  if (files.status === "error") {
    return <ErrorState compact title="Couldn't load the files" failure={files.error} onRetry={files.reload} />;
  }
  const viewed = files.data.filter((file) => file.viewed).length;
  const mark = (file: PullFile, next: boolean) => {
    pullsApi.setViewed(projectId, number, [file.path], next).then(files.reload, (failure: unknown) =>
      pushToast(`Couldn't mark that. ${toFailure(failure).message}`),
    );
  };
  const submit = async (event: string) => {
    setBusy(true);
    try {
      await pullsApi.review(projectId, number, event, body, drafts);
      setDrafts([]);
      setBody("");
      pushToast("Review submitted");
      onReviewed();
    } catch (failure) {
      pushToast(`Couldn't submit the review. ${toFailure(failure).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pull-files">
      {revisions.data && revisions.data.length > 1 ? (
        <select aria-label="Revision" value={revision} onChange={(event) => setRevision(event.target.value)}>
          <option value="">All changes</option>
          {revisions.data.map((commit, at) => (
            <option key={commit.sha} value={commit.sha}>
              {at + 1}. {commit.message} ({commit.sha.slice(0, 7)})
            </option>
          ))}
        </select>
      ) : null}
      {revision ? (
        <p className="muted" role="status">
          {files.data.length === 1 ? "1 file in this commit" : `${files.data.length} files in this commit`}
        </p>
      ) : (
        <p className="muted" role="status">
          {viewed} of {files.data.length} files viewed
        </p>
      )}
      {files.data.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          open={files.data.length <= 5}
          drafts={drafts.filter((draft) => draft.path === file.path)}
          readOnly={revision !== ""}
          onViewed={(next) => mark(file, next)}
          onDraft={(comment) => {
            const rest = drafts.filter((draft) => !(draft.path === comment.path && draft.line === comment.line));
            setDrafts(comment.body === null ? rest : [...rest, comment as ReviewLineComment]);
          }}
        />
      ))}
      {drafts.length > 0 ? (
        <section className="pull-section" aria-label="Review">
          <h3>
            Review, {drafts.length} {drafts.length === 1 ? "comment" : "comments"}
          </h3>
          <textarea aria-label="Review summary" placeholder="Summary" rows={2} value={body} onChange={(event) => setBody(event.target.value)} />
          <div className="pull-form-actions">
            <Button small disabled={busy} onClick={() => void submit("comment")}>
              Submit comments
            </Button>
            <Button small disabled={busy} onClick={() => void submit("approve")}>
              Approve
            </Button>
            <Button small disabled={busy} onClick={() => void submit("request_changes")}>
              Request changes
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
