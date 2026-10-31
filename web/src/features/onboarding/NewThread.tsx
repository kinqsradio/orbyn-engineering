import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { EngineStatus } from "../../api/types";
import { authLabels, signInLabel, slugify, supportLabels, tierLabels } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { navigate, routeHref } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { Button, Field, LinkButton, Pill } from "../../ui/controls";
import { Empty, ErrorState, Loading, PageHeader } from "../../ui/states";

function EngineOption({
  engine,
  name,
  checked,
  onSelect,
}: {
  engine: EngineStatus;
  name: string;
  checked: boolean;
  onSelect(): void;
}) {
  return (
    <label className="engine-option" data-disabled={!engine.installed || undefined}>
      <input type="radio" name={name} checked={checked} disabled={!engine.installed} onChange={onSelect} />
      <span className="engine-option-body">
        <span className="engine-option-title">
          <strong>{engine.name}</strong>
          <Pill>{tierLabels[engine.tier]}</Pill>
          {!engine.capabilities.managed ? <Pill tone="warn">Unmanaged</Pill> : null}
        </span>
        <span className="engine-option-meta">
          {!engine.installed
            ? "Not installed"
            : [
                engine.version,
                authLabels[engine.auth],
                engine.support === "below_minimum" || engine.support === "untested"
                  ? supportLabels[engine.support]
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </span>
        {engine.installed && engine.auth === "logged_out" ? (
          <span className="engine-option-meta">
            {signInLabel(engine)}
            {engine.sign_in_command ? (
              <>
                : <code>{engine.sign_in_command}</code>
              </>
            ) : null}
          </span>
        ) : null}
        {!engine.capabilities.managed ? (
          <span className="engine-option-warn">
            <TriangleAlert size={16} aria-hidden />
            Can't ask permission. Orbyn can't gate what it does.
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function NewThread({ projectId }: { projectId: string | null }) {
  const projects = useWorkspace((state) => state.projects.data);
  const engines = useWorkspace((state) => state.engines);
  const refreshEngines = useWorkspace((state) => state.refreshEngines);
  const putThread = useWorkspace((state) => state.putThread);
  const profiles = useAsync("profiles", (signal) => api.profiles(signal));
  const groupName = useId();

  const [project, setProject] = useState(projectId);
  const [engine, setEngine] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [worktree, setWorktree] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProject(projectId);
  }, [projectId]);

  const list = engines.data ?? [];
  const selectedProject =
    projects?.find((p) => p.id === project) ?? projects?.[0] ?? null;
  const defaultEngine = list.find((e) => e.installed && e.capabilities.managed) ?? null;
  const selectedEngine = engine ?? defaultEngine?.id ?? null;
  const purpose = slugify(worktree);

  if (projects && projects.length === 0) {
    return (
      <div className="page page-narrow">
        <PageHeader title="New thread" back={{ name: "home" }} backLabel="Threads" />
        <Empty title="No projects yet">
          <LinkButton tone="primary" href={routeHref({ name: "add-project" })}>
            Add project
          </LinkButton>
        </Empty>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProject || !selectedEngine) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await api.createThread({
        project_id: selectedProject.id,
        engine: selectedEngine,
        model: model.trim() || null,
        title: title.trim() || null,
        worktree: purpose || null,
        skill_profile: profile || null,
      });
      putThread(thread);
      navigate({ name: "thread", id: thread.id });
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };

  return (
    <div className="page page-narrow">
      <PageHeader title="New thread" back={{ name: "home" }} backLabel="Threads" />
      <form className="form" onSubmit={(event) => void submit(event)}>
        <Field label="Project">
          {(props) => (
            <select
              {...props}
              value={selectedProject?.id ?? ""}
              onChange={(event) => setProject(event.target.value)}
              disabled={!projects}
            >
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {selectedProject && !selectedProject.trusted ? (
          <p className="banner banner-warn">
            This folder isn't trusted yet.{" "}
            <a href={routeHref({ name: "trust", projectId: selectedProject.id, threadId: null })}>
              Review folder
            </a>
          </p>
        ) : null}

        <fieldset className="fieldset">
          <legend>Engine</legend>
          {engines.error && !engines.data ? (
            <ErrorState compact title="Couldn't load engines" failure={engines.error} onRetry={() => void refreshEngines()} />
          ) : !engines.data ? (
            <Loading label="Loading engines" rows={3} />
          ) : list.length === 0 ? (
            <Empty title="No engines found">
              <LinkButton href={routeHref({ name: "settings", section: "engines" })}>Open Engines</LinkButton>
            </Empty>
          ) : (
            <div className="engine-options">
              {list.map((candidate) => (
                <EngineOption
                  key={candidate.id}
                  engine={candidate}
                  name={groupName}
                  checked={candidate.id === selectedEngine}
                  onSelect={() => setEngine(candidate.id)}
                />
              ))}
            </div>
          )}
        </fieldset>

        <Field label="Title (optional)">
          {(props) => <input {...props} value={title} onChange={(event) => setTitle(event.target.value)} />}
        </Field>

        <div className="form-grid">
          <Field label="Model (optional)" hint="Leave empty for the engine's default.">
            {(props) => (
              <input
                {...props}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
              />
            )}
          </Field>
          <Field label="Skill profile">
            {(props) => (
              <select
                {...props}
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
                disabled={profiles.status === "loading"}
              >
                <option value="">All skills</option>
                {(profiles.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        {selectedProject?.is_git !== false ? (
          <Field
            label="Isolated worktree (optional)"
            hint={
              purpose
                ? `Works on its own branch, ${purpose}.`
                : "Name a purpose to work on a separate branch. Empty works in the project folder."
            }
          >
            {(props) => (
              <input
                {...props}
                value={worktree}
                onChange={(event) => setWorktree(event.target.value)}
                placeholder="approval-timeout"
                spellCheck={false}
                autoCapitalize="off"
              />
            )}
          </Field>
        ) : null}

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="form-actions">
          <Button type="submit" tone="primary" busy={busy} disabled={!selectedProject || !selectedEngine}>
            Create thread
          </Button>
        </div>
      </form>
    </div>
  );
}
