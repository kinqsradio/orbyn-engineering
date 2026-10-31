import { Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { request } from "../../api/client";
import type { ScheduledTask } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { Button, Field, IconButton } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const listTasks = (signal?: AbortSignal) => request<ScheduledTask[]>("GET", "/api/tasks", undefined, signal);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function NewTask({ onClose, onSaved }: { onClose(): void; onSaved(): void }) {
  const projects = useVisibleProjects() ?? [];
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [kind, setKind] = useState<"interval" | "fixed_time" | "webhook">("interval");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [project, setProject] = useState(projects[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const engine = engines.find((entry) => entry.installed)?.id ?? "";
  const save = async () => {
    try {
      await request("POST", "/api/tasks", {
        project_id: project,
        name,
        prompt,
        engine,
        schedule: {
          kind,
          every_minutes: kind === "interval" ? Number(minutes) : null,
          time: kind === "fixed_time" ? time : null,
          weekdays: kind === "fixed_time" ? weekdays : [],
          utc_offset_minutes: -new Date().getTimezoneOffset(),
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
      title="New scheduled task"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="primary" disabled={!name.trim() || !prompt.trim() || !project} onClick={() => void save()}>
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
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

export function ScheduledTasksSection() {
  const tasks = useAsync("tasks", listTasks);
  const [adding, setAdding] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const act = (work: Promise<unknown>) =>
    work.then(tasks.reload, (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`));
  return (
    <>
      <div className="section-bar">
        <h1 className="sr-only" tabIndex={-1} data-page-title>
          Scheduled tasks
        </h1>
        <Button small onClick={() => setAdding(true)}>
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
              <IconButton label={`Delete ${task.name}`} onClick={() => void act(request("DELETE", `/api/tasks/${encodeURIComponent(task.id)}`))}>
                <Trash2 size={14} aria-hidden />
              </IconButton>
            </SettingRow>
          ))}
        </SettingGroup>
      )}
      {adding ? <NewTask onClose={() => setAdding(false)} onSaved={tasks.reload} /> : null}
    </>
  );
}

