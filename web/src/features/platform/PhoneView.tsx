import { Check, Loader2, X } from "lucide-react";
import { Button } from "../../ui/controls";
import { SampleNotice, unavailable } from "./Unavailable";
import type { PhoneApproval, PhoneThread } from "./types";

function Marker({ state }: { state: PhoneThread["state"] }) {
  if (state === "approval" || state === "question") return <span className="platform-dot" aria-hidden />;
  if (state === "working") return <Loader2 size={14} className="spin" aria-label="Working" />;
  if (state === "failed") return <X size={14} className="platform-failed" aria-hidden />;
  return <Check size={14} aria-hidden />;
}

const needsYou = (thread: PhoneThread) => thread.state === "approval" || thread.state === "question";

/** The paired phone: what needs you first, then a thread with a one-tap approval. */
export function PhoneView({ threads, approval }: { threads: PhoneThread[]; approval: PhoneApproval }) {
  const waiting = threads.filter(needsYou);
  const ordered = [...waiting, ...threads.filter((thread) => !needsYou(thread))];
  return (
    <div className="platform-phones">
      <section className="platform-phone" aria-label="Threads on a phone">
        <SampleNotice />
        <h2>Threads</h2>
        <p className="platform-hint">{waiting.length} need you</p>
        <ul className="platform-threads">
          {ordered.map((thread) => (
            <li key={thread.id} data-state={thread.state}>
              <Marker state={thread.state} />
              <span className="platform-thread-name">{thread.title}</span>
              <span className="platform-thread-note">{thread.note}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="platform-phone" aria-label="A thread on a phone">
        <SampleNotice />
        <h2>{approval.title}</h2>
        <p className="platform-hint">
          {approval.project} · run {approval.run}
        </p>
        <p className="platform-said">{approval.said}</p>
        <div className="platform-ask">
          <span className="platform-needs">
            <span className="platform-dot" aria-hidden />
            Needs you
          </span>
          <code>{approval.command}</code>
          <span className="platform-hint">{approval.why}</span>
          <div className="platform-actions platform-actions-wide">
            <Button {...unavailable}>Deny</Button>
            <Button tone="primary" {...unavailable}>
              Allow
            </Button>
          </div>
        </div>
        <input className="platform-reply" placeholder="Reply" aria-label="Reply" {...unavailable} />
      </section>
    </div>
  );
}
