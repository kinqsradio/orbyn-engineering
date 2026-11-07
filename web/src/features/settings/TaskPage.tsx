import { AlertTriangle, Check, ChevronLeft, CloudOff, Copy, Loader2, Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { serviceUrl } from "../../api/origin";
import type { ScheduledTask, TaskRun, WebhookDelivery, WebhookEndpoint } from "../../api/types";
import { dayStamp, tookWords, weekdayDate, weekdayStamp } from "../../lib/format";
import { scheduleLabel } from "../../lib/taskSchedule";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useConnection } from "../../state/connection";
import { navigate } from "../../state/route";
import { useUi } from "../../state/ui";
import { useVisibleProjects } from "../../state/workspace";
import { Button } from "../../ui/controls";
import { tabKeys } from "../../ui/tabKeys";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { Empty, Loading } from "../../ui/states";

/** How a run ended, as the service names it; Refused and Skipped say why after a dot. */
const OUTCOMES: Record<string, { label: string; tone?: "blue" | "warn" | "bad"; icon?: "check" | "spin" }> = {
  queued: { label: "Queued" },
  running: { label: "Running", tone: "blue", icon: "spin" },
  completed: { label: "Completed", icon: "check" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled" },
  interrupted: { label: "Interrupted", tone: "warn" },
  refused: { label: "Refused" },
  skipped: { label: "Skipped" },
};

/**
 * The service answers 202 to a request it acted on and 200 to every other it recorded. Only Failed
 * uses the failed mark; each outcome says in a tooltip what it means.
 */
const DELIVERY_STATES: Record<string, { label: string; meaning?: string; tone?: "bad" }> = {
  accepted: { label: "Accepted" },
  bad_signature: { label: "Bad signature", meaning: "The signature didn’t match. Nothing ran." },
  filtered: { label: "Filtered out", meaning: "The event didn’t match this task’s filter. Nothing ran." },
  duplicate: { label: "Duplicate", meaning: "Already received. Nothing ran twice." },
  stale: { label: "Stale", meaning: "Too old to run. Nothing ran." },
  disabled: { label: "Disabled", meaning: "The task or its webhook is off. Nothing ran." },
  failed: { label: "Failed", meaning: "Accepted, but the run failed.", tone: "bad" },
};

const SENDER_LIMIT = 80;
const RUN_COLUMNS = "minmax(0, 1fr) 100px 250px 120px";
const DELIVERY_COLUMNS = "minmax(0, 1fr) 300px 110px 100px";

function Pill({ tone, title, children }: { tone?: "blue" | "warn" | "bad"; title?: string; children: React.ReactNode }) {
  return <span className={tone ? `set-pill ${tone}` : "set-pill"} title={title}>{children}</span>;
}

function RunRow({ run, now }: { run: TaskRun; now: number }) {
  const outcome = OUTCOMES[run.outcome] ?? { label: run.outcome };
  const started = new Date(run.started_at).getTime();
  const end = run.ended_at ? new Date(run.ended_at).getTime() : run.outcome === "running" ? now : null;
  const reason = (run.outcome === "refused" || run.outcome === "skipped") && run.error ? run.error : null;
  return (
    <div role="row" className="set-tr" style={{ gridTemplateColumns: RUN_COLUMNS }}>
      <span role="cell">{weekdayStamp(run.started_at)}</span>
      <span role="cell" className="t3">{end !== null && Number.isFinite(started) ? tookWords(end - started) : "—"}</span>
      <span role="cell">
        <Pill tone={outcome.tone}>
          {outcome.icon === "spin" ? <Loader2 size={13} className="spin" aria-hidden /> : outcome.icon === "check" ? <Check size={13} aria-hidden /> : null}
          {outcome.label}
        </Pill>
        {reason ? <> <span className="t3 set-run-reason">· {reason}</span></> : null}
      </span>
      <span role="cell">
        {run.thread_id ? <Button small tone="quiet" onClick={() => navigate({ name: "thread", id: run.thread_id ?? "" })}>Open thread</Button> : null}
      </span>
    </div>
  );
}

function Runs({ task }: { task: ScheduledTask }) {
  const runs = useAsync(`task-runs:${task.id}`, (signal) => api.taskRuns(task.id, signal));
  if (runs.status === "loading") return <Loading label="Loading runs" rows={3} />;
  if (runs.status === "error") {
    return (
      <p className="banner banner-err" role="alert"><AlertTriangle size={14} aria-hidden />Couldn't load runs.
        <Button small className="set-back-end" icon={<RefreshCw size={13} aria-hidden />} onClick={runs.reload}>Retry</Button></p>
    );
  }
  if (runs.data.length === 0) return <Empty title="No runs yet."><p>Runs appear here after the task first runs.</p></Empty>;
  const now = Date.now();
  return (
    <>
      <div className="set-tbl" role="table" aria-label="Runs">
        <div role="row" className="set-tr h" style={{ gridTemplateColumns: RUN_COLUMNS }}>
          <span role="columnheader">Started</span><span role="columnheader">Took</span><span role="columnheader">Result</span><span />
        </div>
        {runs.data.map((run) => <RunRow key={run.id} run={run} now={now} />)}
      </div>
      <p className="t3 set-foot">Last 50 runs</p>
    </>
  );
}

/** What the sender claims to be, cut to 80 characters. The service only has its headers' word for it. */
const senderLine = (from: string) => `From ${from.length > SENDER_LIMIT ? `${from.slice(0, SENDER_LIMIT)}…` : from}`;

function DeliveryRow({ delivery }: { delivery: WebhookDelivery }) {
  const state = DELIVERY_STATES[delivery.status] ?? { label: delivery.status };
  const accepted = delivery.status === "accepted";
  return (
    <div role="row" className="set-tr" style={{ gridTemplateColumns: DELIVERY_COLUMNS }}>
      <span role="cell">{dayStamp(delivery.received_at)}</span>
      <span role="cell">{delivery.from ? <span className="t3" title="As reported by the sender">{senderLine(delivery.from)}</span> : null}</span>
      <span role="cell">
        <Pill tone={state.tone} title={state.meaning}>{accepted ? <Check size={13} aria-hidden /> : null}{accepted ? "202" : "200"} {state.label}</Pill>
      </span>
      <span role="cell">
        {delivery.thread_id ? <Button small tone="quiet" onClick={() => navigate({ name: "thread", id: delivery.thread_id ?? "" })}>Open thread</Button> : null}
      </span>
    </div>
  );
}

function Deliveries({ task }: { task: ScheduledTask }) {
  const address = useAsync(`webhook:${task.id}`, (signal) => api.taskWebhook(task.id, signal));
  const deliveries = useAsync(`deliveries:${task.id}`, (signal) => api.taskDeliveries(task.id, signal));
  if (deliveries.status === "loading") return <Loading label="Loading deliveries" rows={3} />;
  if (deliveries.status === "error") {
    return (
      <p className="banner banner-err" role="alert"><AlertTriangle size={14} aria-hidden />Couldn't load deliveries.
        <Button small className="set-back-end" icon={<RefreshCw size={13} aria-hidden />} onClick={deliveries.reload}>Retry</Button></p>
    );
  }
  if (deliveries.data.length === 0) {
    const none = task.schedule.kind !== "webhook" || (address.status === "ready" && !address.data.configured);
    return <Empty title="No deliveries yet."><p>{none ? "Create an address to receive them." : "When a service calls the address, each call shows here."}</p></Empty>;
  }
  return (
    <div className="set-tbl" role="table" aria-label="Deliveries">
      <div role="row" className="set-tr h" style={{ gridTemplateColumns: DELIVERY_COLUMNS }}>
        <span role="columnheader">Received</span><span role="columnheader">Sent by</span><span role="columnheader">Answer</span><span />
      </div>
      {deliveries.data.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} />)}
    </div>
  );
}

/** Copy is offered only while the address is still in hand, which is the moment it is issued. */
function CopyOnce({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return <Button small icon={copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>;
}

/** Whether the address takes requests, and the one moment its full text is shown. */
function WebhookAddressRow({ task, offline }: { task: ScheduledTask; offline: boolean }) {
  const address = useAsync(`webhook:${task.id}`, (signal) => api.taskWebhook(task.id, signal));
  const [issued, setIssued] = useState<WebhookEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const issue = () => {
    setError(null);
    setBusy(true);
    api.rotateTaskWebhook(task.id).then(
      (endpoint) => { setIssued(endpoint); address.reload(); },
      (failure: unknown) => setError(toFailure(failure).message),
    ).finally(() => setBusy(false));
  };
  const url = issued ? new URL(serviceUrl(issued.path), window.location.href).href : null;
  const stored = address.status === "ready" ? address.data : null;
  return (
    <>
      <p className="set-grp">Webhook</p>
      <SettingGroup>
        <SettingRow title="Webhook address" description={url ? "Copy it now. It isn’t shown again." : stored && !stored.configured ? "No webhook address yet." : "Anyone with this address can start the task. Keep it private."}>
          {url ? (
            <>
              <code className="set-path" title={url}>{url}</code>
              <CopyOnce text={url} />
            </>
          ) : (
            stored === null ? null : stored.configured ? (
              <>
                <code className="set-path">Configured · {stored.path_prefix}…</code>
                <Button small busy={busy} disabled={offline} onClick={issue}>Regenerate address</Button>
              </>
            ) : (
              <Button small tone="primary" busy={busy} disabled={offline} onClick={issue}>Create address</Button>
            )
          )}
        </SettingRow>
      </SettingGroup>
      {error || address.status === "error" ? <p className="field-error" role="alert">{error ?? "Couldn't load the webhook address."}</p> : null}
    </>
  );
}

type Tab = "runs" | "deliveries";

/** One task: its header, schedule, webhook address, and what ran and what arrived. */
export function TaskPage({ task, onBack, onChanged, onEdit }: { task: ScheduledTask; onBack(): void; onChanged(): void; onEdit(): void }) {
  const offline = useConnection((state) => state.offline);
  const pushToast = useUi((state) => state.pushToast);
  const projects = useVisibleProjects();
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<Tab>("runs");
  const hook = task.schedule.kind === "webhook";
  const tabs: { id: Tab; label: string }[] = [{ id: "runs", label: "Runs" }, { id: "deliveries", label: "Webhook deliveries" }];
  const [runsVersion, setRunsVersion] = useState(0);
  const run = () => {
    setRunning(true);
    api.runTask(task.id).then(() => { onChanged(); setRunsVersion((version) => version + 1); }, (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`)).finally(() => setRunning(false));
  };
  const project = projects?.find((entry) => entry.id === task.project_id)?.name;
  const next = task.enabled && task.next_run_at ? weekdayDate(task.next_run_at) : "";
  return (
    <>
      <div className="set-back">
        <Button small tone="quiet" icon={<ChevronLeft size={13} aria-hidden />} onClick={onBack}>Scheduled tasks</Button>
        <h2 className="set-back-title">{task.name}</h2>
        <span className="set-back-end set-task-actions">
          <Button small onClick={onEdit}>Edit</Button>
          <Button small tone="primary" busy={running} disabled={offline} icon={<Play size={13} aria-hidden />} onClick={run}>Run now</Button>
        </span>
      </div>
      {offline ? <p className="banner" role="status"><CloudOff size={14} aria-hidden />You're offline. Run now is unavailable.</p> : null}
      <div className="set-facts">
        <div><span>When</span><b>{scheduleLabel(task.schedule)}{next ? ` · next ${next}` : ""}</b></div>
        {project ? <div><span>Project</span><b>{project}</b></div> : null}
        <div><span>Prompt</span><b className="set-task-prompt">{task.prompt}</b></div>
      </div>
      {hook ? <WebhookAddressRow task={task} offline={offline} /> : null}
      <div role="tablist" aria-label="History" className="set-tabs" onKeyDown={(event) => tabKeys(event, (at) => setTab(tabs[at]?.id ?? "runs"))}>
        {tabs.map((entry) => (
          <button key={entry.id} type="button" role="tab" id={`task-tab-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`task-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1} onClick={() => setTab(entry.id)}>{entry.label}</button>
        ))}
      </div>
      <div role="tabpanel" id={`task-panel-${tab}`} aria-labelledby={`task-tab-${tab}`}>
        {tab === "runs" ? <Runs key={runsVersion} task={task} /> : <Deliveries task={task} />}
      </div>
    </>
  );
}
