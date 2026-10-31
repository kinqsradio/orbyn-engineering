import { ArrowDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useThreadLogs, type LocalPrompt } from "../../state/threadLogs";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { ThreadItemView, WorkGroupView } from "./items";
import type { MessageItem, ThreadItem } from "./projection";
import { groupWork } from "./timeline";

const NEAR_BOTTOM = 80;
/** Scroll position per thread, kept while switching threads in one visit. */
const scrollMemory = new Map<string, number>();

/** Shows accepted prompts the log hasn't echoed, at the start of their run. */
export function withLocalPrompts(
  items: readonly ThreadItem[],
  prompts: readonly LocalPrompt[],
): readonly ThreadItem[] {
  let merged = items;
  for (const prompt of prompts) {
    const echoed = merged.some(
      (item) => item.kind === "message" && item.role === "user" && item.runId === prompt.runId,
    );
    if (echoed) continue;
    const local: MessageItem = {
      kind: "message",
      key: `local:${prompt.runId}`,
      seq: 0,
      ts: "",
      runId: prompt.runId,
      role: "user",
      text: prompt.text,
      done: true,
    };
    const at = merged.findIndex((item) => item.runId === prompt.runId);
    merged =
      at === -1 ? [...merged, local] : [...merged.slice(0, at), local, ...merged.slice(at)];
  }
  return merged;
}

export function Transcript({
  threadId,
  active,
  engineName,
  footer,
}: {
  threadId: string;
  active: boolean;
  engineName: string | null;
  /** The run status line, which sits at the end of the conversation. */
  footer?: ReactNode;
}) {
  const log = useThreadLogs((state) => state.logs[threadId]);
  const stream = useThreadLogs((state) => state.streams[threadId]);
  const prompts = useThreadLogs((state) => state.prompts[threadId]);
  const items = useMemo(
    () => withLocalPrompts(log?.items ?? [], prompts ?? []),
    [log, prompts],
  );

  const entries = useMemo(() => groupWork(items), [items]);

  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const pinned = useRef(!scrollMemory.has(threadId));
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (pinned.current) element.scrollTop = element.scrollHeight;
    else element.scrollTop = scrollMemory.get(threadId) ?? element.scrollTop;
    // Only the first paint restores; afterwards the pin rule below applies.
    scrollMemory.delete(threadId);
  }, [threadId, items.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pinned means pinned: expanding content, late fonts and streaming all stay in view.
  useEffect(() => {
    const element = scroller.current;
    const content = inner.current;
    if (!element || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [items]);

  useEffect(() => {
    const element = scroller.current;
    return () => {
      if (element && !pinned.current) scrollMemory.set(threadId, element.scrollTop);
    };
  }, [threadId]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element) return;
    const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM;
    pinned.current = atEnd;
    setShowJump(!atEnd);
  };

  const jump = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    element.scrollTop = element.scrollHeight;
    setShowJump(false);
  };

  const status = stream?.status ?? "connecting";
  const empty = items.length === 0;

  return (
    <div className="transcript-wrap">
      <div
        ref={scroller}
        className="transcript"
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Thread messages"
        aria-busy={active || undefined}
      >
        <div ref={inner} className="transcript-inner">
          {empty && status === "failed" && stream?.failure ? (
            <ErrorState title="Couldn't load this thread" failure={stream.failure} />
          ) : empty && (status === "connecting" || status === "reconnecting") ? (
            <Loading label="Loading messages" rows={3} />
          ) : empty ? (
            <Empty title="No messages yet">
              <p>Describe the task below to start a run.</p>
            </Empty>
          ) : (
            entries.map((entry, at) => (
              <div key={entry.key} className={`item item-${entry.kind}`}>
                {entry.kind === "work" ? (
                  <WorkGroupView group={entry} live={active} latest={at >= entries.length - 2} />
                ) : (
                  <ThreadItemView item={entry} live={active} engine={engineName} />
                )}
              </div>
            ))
          )}
          {footer}
        </div>
      </div>
      {showJump ? (
        <Button small className="jump" icon={<ArrowDown size={16} aria-hidden />} onClick={jump}>
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}
