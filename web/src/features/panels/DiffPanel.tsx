import { ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { FileDiff } from "../../api/types";
import { useAsync } from "../../lib/useAsync";
import { useThreadLogs } from "../../state/threadLogs";
import { Button, IconButton, Pill } from "../../ui/controls";
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

function Patch({ patch }: { patch: string }) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  const [all, setAll] = useState(false);
  const visible = all ? lines : lines.slice(0, LINE_LIMIT);
  if (lines.length === 0) return <p className="muted diff-binary">No text changes to show.</p>;
  return (
    <>
      <div className="patch" tabIndex={0} role="group" aria-label="Patch">
        <div className="patch-inner">
          {visible.map((line, at) => {
            const marker = markers[line.kind];
            return (
              <div key={at} className={`patch-line patch-${line.kind}`}>
                {marker ? <span className="sr-only">{marker}: </span> : null}
                {line.text || " "}
              </div>
            );
          })}
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

function FileRow({ file, open, onToggle }: { file: FileDiff; open: boolean; onToggle(): void }) {
  return (
    <li className="diff-file">
      <button type="button" className="diff-file-row" aria-expanded={open} onClick={onToggle}>
        <ChevronRight size={16} className="chev" aria-hidden />
        <span className="diff-path" title={file.path}>
          {file.path}
        </span>
        {file.status !== "modified" ? <Pill>{file.status}</Pill> : null}
        <span className="diff-add">+{file.additions}</span>
        <span className="diff-del">-{file.deletions}</span>
      </button>
      {open ? <Patch patch={file.patch} /> : null}
    </li>
  );
}

export function DiffPanel({ threadId }: { threadId: string }) {
  const version = useThreadLogs((state) => state.diffVersion[threadId] ?? 0);
  const diff = useAsync(`diff:${threadId}`, (signal) => api.diff(threadId, signal));
  const { reload } = diff;
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (version > 0) reload();
  }, [version, reload]);

  if (diff.status === "loading") return <Loading label="Loading diff" />;
  if (diff.status === "error" && !diff.data) {
    return <ErrorState title="Couldn't load the diff" failure={diff.error} onRetry={reload} />;
  }
  const files = diff.data ?? [];
  const added = files.reduce((sum, file) => sum + file.additions, 0);
  const removed = files.reduce((sum, file) => sum + file.deletions, 0);

  return (
    <div>
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
              open={!closed.has(file.path)}
              onToggle={() => {
                const next = new Set(closed);
                if (!next.delete(file.path)) next.add(file.path);
                setClosed(next);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
