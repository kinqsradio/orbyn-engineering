import { chooseDraftEngine } from "../onboarding/draftEngine";
import { AlertTriangle, Check, CloudOff, Plus, RefreshCw, X } from "lucide-react";
import "./ScheduledTasks.css";
import { useEffect, useState } from "react";
import { NETWORK_ERROR, request } from "../../api/client";
import type { ScheduledTask, WebhookFilter } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { relativeTime } from "../../lib/format";
import { scheduleLabel, taskTone, WEEKDAYS } from "../../lib/taskSchedule";
import { useConnection } from "../../state/connection";
import { navigate, useRoute } from "../../state/route";
import { TaskPage } from "./TaskPage";
import { PreferenceGroups } from "./PreferenceRows";
import { settingsLabel } from "./settingsSearch";
import { useUi } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { Button, Field, IconButton } from "../../ui/controls";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { PageBar } from "../../ui/PageBar";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { Empty, Loading } from "../../ui/states";

const listTasks = (signal?: AbortSignal) => request<ScheduledTask[]>("GET", "/api/tasks", undefined, signal);

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
  const [deleting, setDeleting] = useState(false);
  const projects = useVisibleProjects() ?? [];
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const [name, setName] = useState(task?.name ?? "");
  const [touched, setTouched] = useState(false);
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
      className="task-dialog"
      onClose={onClose}
      footer={
        <>
          {task ? <Button tone="quiet" className="task-delete" onClick={() => setDeleting(true)}>Delete task…</Button> : null}
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!name.trim() || !prompt.trim() || !project || (kind === "after_thread" && !after)} onClick={() => void save()}>
            {task ? "Save changes" : "Save task"}
          </Button>
        </>
      }
    >
      <Field label="Name" error={touched && !name.trim() ? "Give the task a name." : undefined}>
        {(props) => <input {...props} required placeholder="Name this task" value={name}
          onChange={(event) => { setTouched(true); setName(event.target.value); }} onBlur={() => setTouched(true)} />}
      </Field>
      <Field label="What should the agent do?">
        {(props) => <textarea {...props} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />}
      </Field>
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
      {deleting && task ? (
        <ConfirmDialog title={`Delete ${task.name}?`} confirmLabel="Delete task" tone="danger" onClose={() => setDeleting(false)}
          onConfirm={async () => { await request("DELETE", `/api/tasks/${q(task.id)}`); onSaved(); onClose(); }}>
          <p>The task stops running. Threads it already started stay.</p>
        </ConfirmDialog>
      ) : null}
    </Dialog>
  );
}

/** Where the last firing ended: nothing yet, running or started, or the reason it failed. */
function LastRun({ task }: { task: ScheduledTask }) {
  const tone = taskTone(task);
  if (tone === "idle") return <span className="task-last">—</span>;
  const when = task.last_run_at ? relativeTime(task.last_run_at) : "";
  if (tone === "fail") {
    return (
      <span className="task-last" data-tone="fail">
        <X size={12} aria-hidden />
        Failed · {task.last_status}
      </span>
    );
  }
  return (
    <span className="task-last">
      <Check size={12} aria-hidden />
      {when ? `Started ${when.toLowerCase()}` : "Started"}
    </span>
  );
}

/** What every task follows: whether a run waits for room under a usage limit, and whether you hear when one ends. */
function TaskDefaults() {
  const notify = useUi((state) => state.taskRunNotifications);
  const setPrefs = useUi((state) => state.setPrefs);
  const title = settingsLabel("tasks-notify-runs");
  return (
    <>
      <PreferenceGroups groups={[{ title: "", rows: [{
        key: "task_skip_near_limit",
        title: settingsLabel("tasks-skip-near-limit"),
        description: "Waits until a limit window has room (90% used or more). Applies to scheduled and follow-up runs.",
      }] }]} />
      <SettingGroup>
        <SettingRow title={title}>
          <input type="checkbox" role="switch" aria-label={title} checked={notify} onChange={(event) => setPrefs({ taskRunNotifications: event.target.checked })} />
        </SettingRow>
      </SettingGroup>
    </>
  );
}

function TasksView({ page }: { page: boolean }) {
  const tasks = useAsync("tasks", listTasks);
  const [editing, setEditing] = useState<ScheduledTask | "new" | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const offline = useConnection((state) => state.offline);
  const pushToast = useUi((state) => state.pushToast);
  const projects = useVisibleProjects();
  const route = useRoute();
  const linkedId = route.name === "settings" ? route.task : undefined;
  const linkedEdit = route.name === "settings" && route.edit === true;
  const [openedLink, setOpenedLink] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (linkedId === undefined) {
      setOpenedLink(undefined);
      return;
    }
    if (openedLink === linkedId || tasks.status !== "ready") return;
    setOpenedLink(linkedId);
    const task = tasks.data.find((entry) => entry.id === linkedId);
    if (!task) navigate({ name: "settings", section: "tasks" });
    else if (linkedEdit) setEditing(task);
    else {
      // A plain link opens the task's page, on its Runs tab; the editor opens only from Edit.
      setOpened(task.id);
      navigate({ name: "settings", section: "tasks" });
    }
  }, [linkedId, linkedEdit, openedLink, tasks.status, tasks.data]);

  const closeEditor = () => {
    setEditing(null);
    if (linkedId !== undefined) navigate({ name: "settings", section: "tasks" });
  };

  const act = (work: Promise<unknown>) =>
    work.then(tasks.reload, (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`));
  const newTask = (
    <Button small tone="primary" disabled={offline} icon={<Plus size={14} aria-hidden />} onClick={() => setEditing("new")}>
      New task
    </Button>
  );
  const openTask = opened === null ? undefined : tasks.data?.find((entry) => entry.id === opened);
  const content = openTask ? (
    <TaskPage task={openTask} onBack={() => setOpened(null)} onChanged={tasks.reload} onEdit={() => setEditing(openTask)} />
  ) : (
    <>
      {page ? (
        <PageBar actions={newTask}>
          <h1 tabIndex={-1} data-page-title>
            Scheduled tasks
          </h1>
        </PageBar>
      ) : (
        <>
          <h1 className="sr-only" tabIndex={-1} data-page-title>
            Scheduled tasks
          </h1>
          <TaskDefaults />
          <div className="tasks-head">
            <p className="set-grp">Tasks</p>
            {newTask}
          </div>
        </>
      )}
      <div className="tasks-body">
        {offline ? <p className="banner" role="status"><CloudOff size={14} aria-hidden />You're offline. New task is unavailable.</p> : null}
        {tasks.status === "loading" ? (
          <Loading label="Loading tasks" rows={3} />
        ) : tasks.status === "error" ? (
          <p className="banner banner-err" role="alert"><AlertTriangle size={14} aria-hidden />
            {tasks.error.code === NETWORK_ERROR ? "Couldn't load your tasks. orbynd stopped answering. Your tasks are saved." : `Couldn't load your tasks. ${tasks.error.message}`}
            <Button small className="set-back-end" icon={<RefreshCw size={13} aria-hidden />} onClick={tasks.reload}>Retry</Button></p>
        ) : tasks.data.length === 0 ? (
          <Empty title="No scheduled tasks">
            <p>Run a prompt on a schedule: dependency updates, issue triage, a weekly audit.</p>
            <Button tone="primary" small disabled={offline} icon={<Plus size={14} aria-hidden />} onClick={() => setEditing("new")}>New task</Button>
          </Empty>
        ) : (
          <div className="task-table" role="table" aria-label="Tasks">
            <div className="task-row task-head" role="row">
              <span role="columnheader">Task</span>
              <span role="columnheader">When</span>
              <span role="columnheader">Last run</span>
              <span role="columnheader">On</span>
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>
            {tasks.data.map((task) => {
              const project = projects?.find((entry) => entry.id === task.project_id)?.name;
              return (
                <div className="task-row" role="row" key={task.id} data-paused={task.enabled ? undefined : true}
                  onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, a")) setOpened(task.id); }}>
                  <span role="cell" className="task-name">
                    <button type="button" className="set-link" aria-label={`Open ${task.name}`} onClick={() => setOpened(task.id)}><b>{task.name}</b></button>
                    <small>{project}</small>
                  </span>
                  <span role="cell" className="task-when">
                    {scheduleLabel(task.schedule)}
                    <small>
                      {!task.enabled ? "Paused" : task.next_run_at ? `Next run ${new Date(task.next_run_at).toLocaleString()}` : ""}
                    </small>
                  </span>
                  <span role="cell">
                    <LastRun task={task} />
                  </span>
                  <span role="cell">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`Enable ${task.name}`}
                      checked={task.enabled}
                      onChange={(event) =>
                        void act(request("POST", `/api/tasks/${encodeURIComponent(task.id)}/enabled`, { enabled: event.target.checked }))
                      }
                    />
                  </span>
                  <span role="cell" className="task-actions">
                    <Button small aria-label={`Edit ${task.name}`} onClick={() => setEditing(task)}>Edit</Button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
  const dialog = editing ? <TaskDialog task={editing === "new" ? null : editing} onClose={closeEditor} onSaved={tasks.reload} /> : null;
  return page ? <div className="tasks-page">{content}{dialog}</div> : <>{content}{dialog}</>;
}

/** Scheduled tasks as a section of Settings. */
export function ScheduledTasksSection() {
  return <TasksView page={false} />;
}

/** Scheduled tasks as a page of their own, reached from the sidebar. */
export function ScheduledTasksPage() {
  return <TasksView page />;
}
