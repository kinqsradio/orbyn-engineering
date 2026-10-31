import { ArrowDown } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useThreadLogs, type LocalPrompt } from "../../state/threadLogs";
import { useUi } from "../../state/ui";
import { useLoopsWhileVisible } from "../../lib/visibleAnimation";
import { Button } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { TimelineRow, TimelineThread } from "./items";
import { Minimap } from "./Minimap";
import type { MessageItem, ThreadItem } from "./projection";
import { arrangeTimeline, entryForMessage, entryIndexOf, firstUnread, runningTools } from "./timeline";

const NEAR_BOTTOM = 80;
const NO_RUNS = {};
const REVEAL_MS = 2000;
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
  activeRunId,
  footer,
  readUpTo,
}: {
  threadId: string;
  active: boolean;
  activeRunId?: string | null;
  /** Rows after this time are new to you, and a line marks where they start. */
  readUpTo?: string | null;
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

  const entries = useMemo(
    () => arrangeTimeline(items, log?.runs ?? NO_RUNS, activeRunId ?? null),
    [items, log?.runs, activeRunId],
  );
  const tools = useMemo(() => (active ? runningTools(items) : []), [items, active]);
  const turnPrompts = useMemo(
    () => items.flatMap((item) => (item.kind === "message" && item.role === "user" ? [{ key: item.key, text: item.text }] : [])),
    [items],
  );

  const [arrivedAt] = useState(() => new Date().toISOString());
  const newKey = useMemo(() => firstUnread(items, readUpTo ?? null, arrivedAt), [items, readUpTo, arrivedAt]);
  const newAt = newKey ? entryIndexOf(entries, newKey) : -1;

  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLoopsWhileVisible(scroller);
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

  const reveal = useUi((state) => (state.messageReveal?.threadId === threadId ? state.messageReveal : null));
  const clearReveal = useUi((state) => state.clearMessageReveal);
  useEffect(() => {
    if (!reveal || entries.length === 0) return;
    const key = entryForMessage(entries, reveal.messageId);
    if (!key) return;
    const row = scroller.current?.querySelector(`[data-entry="${CSS.escape(key)}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.setAttribute("data-revealed", "true");
    pinned.current = false;
    clearReveal();
    const timer = setTimeout(() => row?.removeAttribute("data-revealed"), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [reveal, entries, clearReveal]);

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
            <TimelineThread value={threadId}>
              {entries.map((entry, at) => (
                <Fragment key={entry.key}>
                  {at === newAt ? (
                    <p className="visit-mark" role="separator">
                      New since you were here
                    </p>
                  ) : null}
                  <div className={`item item-${entry.kind}`} data-entry={entry.key}>
                    <TimelineRow entry={entry} live={active} tools={tools} />
                  </div>
                </Fragment>
              ))}
            </TimelineThread>
          )}
          {footer}
        </div>
      </div>
      <Minimap items={turnPrompts} scroller={scroller} />
      {showJump ? (
        <Button small className="jump" icon={<ArrowDown size={16} aria-hidden />} onClick={jump}>
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}
