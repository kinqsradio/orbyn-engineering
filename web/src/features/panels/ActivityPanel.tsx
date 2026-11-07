import { useState } from "react";
import { clockTime, fullTime } from "../../lib/format";
import { useThreadLogs } from "../thread/threadLogs";
import { Empty } from "../../ui/states";
import { filterActivity, summarizeActivity, type ActivityFilter } from "./activityView";

const FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "commands", label: "Commands" },
  { id: "edits", label: "Edits" },
];

/** The thread's activity. Remount it per thread so the filter starts at All. */
export function ActivityPanel({ threadId }: { threadId: string }) {
  const timeline = useThreadLogs((state) => state.logs[threadId]?.timeline ?? []);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  if (timeline.length === 0) return <Empty title="No activity yet" />;
  const shown = filterActivity(timeline, filter);
  const summary = summarizeActivity(timeline);
  return (
    <>
      <div className="activity-head">
        <div className="segment" role="radiogroup" aria-label="Activity filter">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" role="radio" aria-checked={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        {summary ? <span className="activity-summary">{summary}</span> : null}
      </div>
      {shown.length === 0 ? (
        <Empty title="Nothing matches this filter" />
      ) : (
        <ol className="timeline">
          {[...shown].reverse().map((entry) => (
            <li key={`${entry.seq}-${entry.label}`} data-tone={entry.tone}>
              <time dateTime={entry.ts} title={fullTime(entry.ts)}>
                {clockTime(entry.ts)}
              </time>
              <div>
                <span className="timeline-label">{entry.label}</span>
                {entry.detail ? <span className="timeline-detail">{entry.detail}</span> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
