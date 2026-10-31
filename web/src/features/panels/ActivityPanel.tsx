import { clockTime, fullTime } from "../../lib/format";
import { useThreadLogs } from "../../state/threadLogs";
import { Empty } from "../../ui/states";

export function ActivityPanel({ threadId }: { threadId: string }) {
  const timeline = useThreadLogs((state) => state.logs[threadId]?.timeline ?? []);
  if (timeline.length === 0) return <Empty title="No activity yet" />;
  return (
    <ol className="timeline">
      {[...timeline].reverse().map((entry) => (
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
  );
}
