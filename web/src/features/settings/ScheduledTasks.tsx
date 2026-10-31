import { chooseDraftEngine } from "../onboarding/draftEngine";
import { Pencil, Play, Plus, ScrollText, Trash2, Webhook, X } from "lucide-react";
import { useState } from "react";
import { request } from "../../api/client";
import type { ScheduledTask, WebhookDelivery, WebhookEndpoint, WebhookFilter } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { Button, CopyCommand, Field, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const listTasks = (signal?: AbortSignal) => request<ScheduledTask[]>("GET", "/api/tasks", undefined, signal);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type TaskKind = "interval" | "fixed_time" | "webhook" | "after_thread";

const q = encodeURIComponent;
const MAX_FILTERS = 16;
const FILTER_OPS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "starts_with", label: "starts with" },
  { value: "in", label: "is one of" },
  { value: "exists", label: "exists" },
];

/** What a filter holds in the form: one text box, split for `in` when it is saved. */
interface FilterRow {
  path: string;
  op: string;
  value: string;
}
const toRow = (filter: WebhookFilter): FilterRow => ({
  path: filter.path,
  op: filter.op,
  value: Array.isArray(filter.value) ? filter.value.join(", ") : typeof filter.value === "string" ? filter.value : "",
});
const toFilter = ({ path, op, value }: FilterRow): WebhookFilter => ({
  path,
  op,
  value: op === "exists" ? null : op === "in" ? value.split(",").map((entry) => entry.trim()) : value,
});

function WebhookFields({
  header,
  encoding,
  prefix,
  secret,
  hasSecret,
  filters,
  dedupe,
  window: windowSeconds,
  maxAge,
  timestamp,
  change,
}: {
  header: string;
  encoding: string;
  prefix: string;
  secret: string;
  hasSecret: boolean;
  filters: FilterRow[];
  dedupe: string;
  window: string;
  maxAge: string;
  timestamp: string;
  change(patch: Record<string, string | FilterRow[]>): void;
}) {
  const setRow = (at: number, patch: Partial<FilterRow>) =>
    change({ filters: filters.map((row, index) => (index === at ? { ...row, ...patch } : row)) });
  return (
    <>
      <fieldset className="task-group">
        <legend>Signature</legend>
        <Field label="Header">
          {(props) => <input {...props} placeholder="X-Hub-Signature-256" value={header} onChange={(event) => change({ header: event.target.value })} />}
        </Field>
        <Field label="Encoding">
          {(props) => (
            <select {...props} value={encoding} onChange={(event) => change({ encoding: event.target.value })}>
              <option value="hex">Hex</option>
              <option value="base64">Base64</option>
            </select>
          )}
        </Field>
        <Field label="Prefix">
          {(props) => <input {...props} placeholder="sha256=" value={prefix} onChange={(event) => change({ prefix: event.target.value })} />}
        </Field>
        <Field label="Secret" hint={hasSecret ? "Saved. Leave empty to keep it." : undefined}>
          {(props) => <input {...props} type="password" autoComplete="off" value={secret} onChange={(event) => change({ secret: event.target.value })} />}
        </Field>
      </fieldset>
      <fieldset className="task-group">
        <legend>Filters</legend>
        {filters.map((row, at) => (
          <div className="task-filter" key={at}>
            <input aria-label={`Filter ${at + 1} path`} placeholder="action" value={row.path} onChange={(event) => setRow(at, { path: event.target.value })} />
            <select aria-label={`Filter ${at + 1} test`} value={row.op} onChange={(event) => setRow(at, { op: event.target.value })}>
              {FILTER_OPS.map((op) => (
                <option key={op.value} value={op.value}>
                  {op.label}
                </option>
              ))}
            </select>
            {row.op === "exists" ? null : (
              <input aria-label={`Filter ${at + 1} value`} placeholder="Value" value={row.value} onChange={(event) => setRow(at, { value: event.target.value })} />
            )}
            <IconButton label={`Remove filter ${at + 1}`} onClick={() => change({ filters: filters.filter((_, index) => index !== at) })}>
              <X size={14} aria-hidden />
            </IconButton>
          </div>
        ))}
        <Button
          small
          icon={<Plus size={14} aria-hidden />}
          disabled={filters.length >= MAX_FILTERS}
          onClick={() => change({ filters: [...filters, { path: "", op: "equals", value: "" }] })}
        >
          Add filter
        </Button>
      </fieldset>
      <fieldset className="task-group">
        <legend>Repeats and old deliveries</legend>
        <Field label="Skip repeats of this field">
          {(props) => <input {...props} placeholder="delivery.id" value={dedupe} onChange={(event) => change({ dedupe: event.target.value })} />}
        </Field>
        <Field label="Within (seconds)">
          {(props) => <input {...props} type="number" min="1" value={windowSeconds} onChange={(event) => change({ window: event.target.value })} />}
        </Field>
        <Field label="Timestamp field">
          {(props) => <input {...props} placeholder="sent_at" value={timestamp} onChange={(event) => change({ timestamp: event.target.value })} />}
        </Field>
        <Field label="Skip after (seconds)">
          {(props) => <input {...props} type="number" min="1" value={maxAge} onChange={(event) => change({ maxAge: event.target.value })} />}
        </Field>
      </fieldset>
    </>
  );
}

/** Adds a task, or edits one. What this form doesn't show goes back as it came. */
function TaskDialog({ task, onClose, onSaved }: { task: ScheduledTask | null; onClose(): void; onSaved(): void }) {
  const projects = useVisibleProjects() ?? [];
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [minutes, setMinutes] = useState(String(task?.schedule.every_minutes ?? 60));
  const [kind, setKind] = useState<TaskKind>((task?.schedule.kind as TaskKind | undefined) ?? "interval");
  const [time, setTime] = useState(task?.schedule.time ?? "09:00");
  const [weekdays, setWeekdays] = useState<number[]>(task?.schedule.weekdays ?? []);
  const [project, setProject] = useState(task?.project_id ?? projects[0]?.id ?? "");
  const [hook, setHook] = useState({
    header: task?.signature?.header ?? "",
    encoding: task?.signature?.encoding ?? "hex",
    prefix: task?.signature?.prefix ?? "",
    secret: "",
    filters: (task?.filters ?? []).map(toRow),
    dedupe: task?.dedupe?.path ?? "",
    window: String(task?.dedupe?.window_seconds ?? 3600),
    maxAge: task?.max_age_seconds ? String(task.max_age_seconds) : "",
    timestamp: task?.timestamp_path ?? "",
  });
  const threads = Object.values(useWorkspace((state) => state.threads)).filter((thread) => thread.project_id === project);
  const [after, setAfter] = useState(task?.schedule.after_thread ?? "");
  const [onlySuccess, setOnlySuccess] = useState(task?.schedule.only_on_success ?? false);
  const [error, setError] = useState<string | null>(null);
  const engine = task?.engine ?? chooseDraftEngine(engines.filter((entry) => entry.installed), null, false)?.id ?? "";
  const save = async () => {
    try {
      const kept = task ? { thread_id: task.thread_id ?? undefined } : {};
      const webhook =
        kind === "webhook"
          ? {
              signature: hook.header.trim()
                ? { header: hook.header.trim(), encoding: hook.encoding, prefix: hook.prefix }
                : undefined,
              secret: hook.secret || undefined,
              filters: hook.filters.filter((row) => row.path.trim()).map(toFilter),
              dedupe: hook.dedupe.trim() ? { path: hook.dedupe.trim(), window_seconds: Number(hook.window) } : undefined,
              max_age_seconds: hook.maxAge ? Number(hook.maxAge) : undefined,
              timestamp_path: hook.timestamp.trim() || undefined,
            }
          : {};
      await request(task ? "PUT" : "POST", task ? `/api/tasks/${encodeURIComponent(task.id)}` : "/api/tasks", {
        ...kept,
        ...webhook,
        project_id: project,
        name,
        prompt,
        engine,
        schedule: {
          ...task?.schedule,
          kind,
          every_minutes: kind === "interval" ? Number(minutes) : null,
          time: kind === "fixed_time" ? time : null,
          weekdays: kind === "fixed_time" ? weekdays : [],
          utc_offset_minutes: -new Date().getTimezoneOffset(),
          after_thread: kind === "after_thread" ? after : undefined,
          only_on_success: kind === "after_thread" && onlySuccess,
        },
      });
      onSaved();
      onClose();
    } catch (failure) {
      setError(toFailure(failure).message);
    }
  };
  return (
    <Dialog
      title={task ? "Edit scheduled task" : "New scheduled task"}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!name.trim() || !prompt.trim() || !project || (kind === "after_thread" && !after)} onClick={() => void save()}>
            Save task
          </Button>
        </>
      }
    >
      <Field label="Name">{(props) => <input {...props} value={name} onChange={(event) => setName(event.target.value)} />}</Field>
      <Field label="Project">
        {(props) => (
          <select {...props} value={project} onChange={(event) => setProject(event.target.value)}>
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Prompt">
        {(props) => <textarea {...props} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />}
      </Field>
      <Field label="Schedule">
        {(props) => (
          <select {...props} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            <option value="interval">Every few minutes</option>
            <option value="fixed_time">At a time</option>
            <option value="webhook">From a webhook</option>
            <option value="after_thread">After another thread</option>
          </select>
        )}
      </Field>
      {kind === "interval" ? (
        <Field label="Every (minutes)">
          {(props) => (
            <input {...props} type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
          )}
        </Field>
      ) : null}
      {kind === "fixed_time" ? (
        <>
          <Field label="Time">{(props) => <input {...props} type="time" value={time} onChange={(event) => setTime(event.target.value)} />}</Field>
          <fieldset className="task-days">
            <legend>Days, none for every day</legend>
            {WEEKDAYS.map((day, at) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={weekdays.includes(at)}
                  onChange={(event) =>
                    setWeekdays(event.target.checked ? [...weekdays, at] : weekdays.filter((entry) => entry !== at))
                  }
                />
                {day}
              </label>
            ))}
          </fieldset>
        </>
      ) : null}
      {kind === "webhook" ? (
        <WebhookFields {...hook} hasSecret={task?.has_secret ?? false} change={(patch) => setHook({ ...hook, ...patch })} />
      ) : null}
      {kind === "after_thread" ? (
        <>
          <Field label="Thread">
            {(props) => (
              <select {...props} value={after} onChange={(event) => setAfter(event.target.value)}>
                <option value="">Choose a thread</option>
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="check">
            <input type="checkbox" checked={onlySuccess} onChange={(event) => setOnlySuccess(event.target.checked)} />
            <span>Only when it succeeds</span>
          </label>
        </>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The address is shown once, when it's issued. A new one ends the old. */
function WebhookDialog({ task, onClose }: { task: ScheduledTask; onClose(): void }) {
  const [endpoint, setEndpoint] = useState<WebhookEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const issue = () => {
    setError(null);
    request<WebhookEndpoint>("POST", `/api/tasks/${q(task.id)}/webhook`).then(setEndpoint, (failure: unknown) =>
      setError(toFailure(failure).message),
    );
  };
  const url = endpoint ? `${window.location.origin}${endpoint.path}` : null;
  return (
    <Dialog title="Webhook address" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {url ? (
        <CopyCommand command={url} label="Copy webhook address" />
      ) : (
        <p>Issuing an address ends the one before it. It works wherever this computer can be reached.</p>
      )}
      <Button small onClick={issue}>
        {url ? "Issue another" : "Issue address"}
      </Button>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

function DeliveriesDialog({ task, onClose }: { task: ScheduledTask; onClose(): void }) {
  const list = useAsync(`deliveries:${task.id}`, (signal) =>
    request<WebhookDelivery[]>("GET", `/api/tasks/${q(task.id)}/deliveries`, undefined, signal),
  );
  return (
    <Dialog title={`Deliveries for ${task.name}`} onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
      {list.status === "loading" ? (
        <Loading label="Loading deliveries" rows={3} />
      ) : list.status === "error" ? (
        <ErrorState compact title="Couldn't load deliveries" failure={list.error} onRetry={list.reload} />
      ) : list.data.length === 0 ? (
        <Empty title="No deliveries yet" />
      ) : (
        <ul className="task-deliveries" aria-label="Deliveries">
          {list.data.map((delivery) => (
            <li key={delivery.id}>
              <details>
                <summary>
                  <span>{DELIVERY_STATES[delivery.status] ?? delivery.status}</span>
                  <time>{new Date(delivery.received_at).toLocaleString()}</time>
                </summary>
                <h4>Headers</h4>
                <pre tabIndex={0}>{JSON.stringify(delivery.headers, null, 2)}</pre>
                <h4>Body</h4>
                <pre tabIndex={0}>{delivery.body}</pre>
                {delivery.prompt ? (
                  <>
                    <h4>Prompt</h4>
                    <pre tabIndex={0}>{delivery.prompt}</pre>
                  </>
                ) : null}
              </details>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

const DELIVERY_STATES: Record<string, string> = {
  accepted: "Accepted",
  bad_signature: "Bad signature",
  filtered: "Filtered out",
  duplicate: "Duplicate",
  stale: "Too old",
  disabled: "Task paused",
  failed: "Failed",
};

export function ScheduledTasksSection() {
  const tasks = useAsync("tasks", listTasks);
  const [editing, setEditing] = useState<ScheduledTask | "new" | null>(null);
  const [webhook, setWebhook] = useState<ScheduledTask | null>(null);
  const [deliveries, setDeliveries] = useState<ScheduledTask | null>(null);
  const pushToast = useUi((state) => state.pushToast);
  const act = (work: Promise<unknown>) =>
    work.then(tasks.reload, (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`));
  return (
    <>
      <div className="section-bar">
        <h1 className="sr-only" tabIndex={-1} data-page-title>
          Scheduled tasks
        </h1>
        <Button small onClick={() => setEditing("new")}>
          New task
        </Button>
      </div>
      {tasks.status === "loading" ? (
        <Loading label="Loading tasks" rows={3} />
      ) : tasks.status === "error" ? (
        <ErrorState title="Couldn't load tasks" failure={tasks.error} onRetry={tasks.reload} />
      ) : tasks.data.length === 0 ? (
        <Empty title="No scheduled tasks" />
      ) : (
        <SettingGroup title="Tasks">
          {tasks.data.map((task) => (
            <SettingRow
              key={task.id}
              title={task.name}
              description={task.next_run_at ? `Next run ${new Date(task.next_run_at).toLocaleString()}` : task.last_status}
            >
              <input
                type="checkbox"
                role="switch"
                aria-label={`Enable ${task.name}`}
                checked={task.enabled}
                onChange={(event) =>
                  void act(request("POST", `/api/tasks/${encodeURIComponent(task.id)}/enabled`, { enabled: event.target.checked }))
                }
              />
              <IconButton label={`Run ${task.name}`} onClick={() => void act(request("POST", `/api/tasks/${encodeURIComponent(task.id)}/run`))}>
                <Play size={14} aria-hidden />
              </IconButton>
              {task.schedule.kind === "webhook" ? (
                <>
                  <IconButton label={`Webhook address for ${task.name}`} onClick={() => setWebhook(task)}>
                    <Webhook size={14} aria-hidden />
                  </IconButton>
                  <IconButton label={`Deliveries for ${task.name}`} onClick={() => setDeliveries(task)}>
                    <ScrollText size={14} aria-hidden />
                  </IconButton>
                </>
              ) : null}
              <IconButton label={`Edit ${task.name}`} onClick={() => setEditing(task)}>
                <Pencil size={14} aria-hidden />
              </IconButton>
              <IconButton label={`Delete ${task.name}`} onClick={() => void act(request("DELETE", `/api/tasks/${encodeURIComponent(task.id)}`))}>
                <Trash2 size={14} aria-hidden />
              </IconButton>
            </SettingRow>
          ))}
        </SettingGroup>
      )}
      {editing ? (
        <TaskDialog task={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={tasks.reload} />
      ) : null}
      {webhook ? <WebhookDialog task={webhook} onClose={() => setWebhook(null)} /> : null}
      {deliveries ? <DeliveriesDialog task={deliveries} onClose={() => setDeliveries(null)} /> : null}
    </>
  );
}

