import { Laptop, MessageSquare } from "lucide-react";
import { SampleNotice, unavailable } from "./Unavailable";

const threads = [
  { name: "Fix login redirect", note: "paused" },
  { name: "Project icon picker", note: "2h" },
  { name: "Usage cost filters", note: "1d" },
];

/** Paired machine offline: the phone names the Mac and when it was last seen. Sample data only. */
export function PhoneOffline() {
  return (
    <div className="platform-phones">
      <section className="platform-phone" aria-label="Threads on a phone, machine offline">
        <SampleNotice />
        <h2>Threads</h2>
        <p className="platform-hint">MacBook Pro is offline</p>
        <p className="conn-banner" role="status" style={{ marginInline: 16 }}>
          <Laptop size={13} aria-hidden />
          <span>MacBook Pro is offline · last seen 09:12. Threads resume when it’s back.</span>
        </p>
        <ul className="platform-threads" style={{ opacity: 0.7 }}>
          {threads.map((thread) => (
            <li key={thread.name}>
              <MessageSquare size={13} aria-hidden />
              <span className="platform-thread-name">{thread.name}</span>
              <span className="platform-thread-note">{thread.note}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="platform-phone" aria-label="A thread on a phone, machine offline">
        <SampleNotice />
        <h2>Fix login redirect</h2>
        <p className="platform-hint">MacBook Pro is offline</p>
        <p className="platform-said" style={{ opacity: 0.7 }}>
          The redirect ignores the next parameter, so everyone lands on /home.
        </p>
        <input className="platform-reply" placeholder="Message queued for MacBook Pro" aria-label="Reply" {...unavailable} />
      </section>
    </div>
  );
}
