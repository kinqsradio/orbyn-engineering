import { Trash2, TriangleAlert, Settings2 } from "lucide-react";
import { useState } from "react";
import { ApiFailure, api } from "../../api/client";
import type { LibraryStatus, TargetStatus } from "../../api/types";
import type { ProjectScript } from "../../generated/ProjectScript";
import { useWorkspace } from "../../state/workspace";
import { PreferenceGroups } from "./PreferenceRows";
import { Button, Pill } from "../../ui/controls";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";

const short = (revision: string | null) => revision?.slice(0, 8) ?? "Unknown";

export function FallbackNotice() {
  return (
    <p className="banner banner-warn">
      <TriangleAlert size={16} aria-hidden />
      Skill links didn't materialize here, so skills are reaching engines through the fallback route.
    </p>
  );
}

export function Library({ library }: { library: LibraryStatus }) {
  const updates = useWorkspace((state) => state.updates.data);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const refreshUpdates = useWorkspace((state) => state.refreshUpdates);
  const [dialog, setDialog] = useState<"update" | "rollback" | null>(null);
  const blocked =
    updates?.library.blocked_reason ??
    (library.dirty ? "The library has local changes. Commit or discard them first." : null);
  const canUpdate = blocked === null && library.behind > 0;
  const refresh = () => Promise.all([refreshManaged(), refreshUpdates()]).then(() => undefined);

  return (
    <>
      {library.problem ? <p className="banner banner-warn">{library.problem}</p> : null}
      <dl className="facts facts-block">
        <div>
          <dt>Skills library</dt>
          <dd>
            <code>{library.path}</code>
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>
            <code>{short(library.revision)}</code>
          </dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{library.branch ?? "Detached"}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>
            {library.dirty ? (
              <Pill tone="warn">
                {library.dirty_files.length === 1 ? "1 modified file" : `${library.dirty_files.length} modified files`}
              </Pill>
            ) : (
              "None"
            )}
          </dd>
        </div>
        <div>
          <dt>Remote</dt>
          <dd>
            {library.ahead} ahead, {library.behind} behind
          </dd>
        </div>
      </dl>
      <div className="form-actions">
        <Button tone="primary" small disabled={!canUpdate} onClick={() => setDialog("update")}>
          Review update
        </Button>
        <Button
          small
          disabled={blocked !== null || !library.previous_revision}
          onClick={() => setDialog("rollback")}
        >
          Roll back
        </Button>
      </div>
      {blocked ? (
        <p className="update-reason">{blocked}</p>
      ) : library.behind === 0 ? (
        <p className="update-reason">The library is up to date.</p>
      ) : null}
      {dialog === "update" ? (
        <ConfirmDialog
          title="Update the library?"
          confirmLabel="Update"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.updateLibrary(true);
            await refresh();
          }}
        >
          <p>
            {updates?.library.incoming.length === 1
              ? "1 incoming commit:"
              : `${updates?.library.incoming.length ?? library.behind} incoming commits:`}
          </p>
          <ul className="commit-list">
            {(updates?.library.incoming ?? []).map((commit) => (
              <li key={commit.sha}>
                <code>{short(commit.sha)}</code>
                <span>{commit.subject}</span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      ) : null}
      {dialog === "rollback" ? (
        <ConfirmDialog
          title="Roll back the library?"
          confirmLabel="Roll back"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.rollbackLibrary();
            await refresh();
          }}
        >
          <p>
            The library returns to <code>{short(library.previous_revision)}</code>. New runs use that
            revision.
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function RemoveDialog({
  target,
  name,
  onClose,
  onKept,
}: {
  target: TargetStatus;
  name: string;
  onClose(): void;
  onKept(note: string): void;
}) {
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const dropProject = useWorkspace((state) => state.dropProject);
  /** Only the server knows a folder is its own to delete, and only then is there a choice. */
  const [managedWork, setManagedWork] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const projectId = target.project_id;

  return (
    <ConfirmDialog
      title={`Remove ${name}?`}
      confirmLabel="Remove project"
      tone="danger"
      confirmDisabled={managedWork !== null && !acknowledged}
      keepOpen
      onClose={onClose}
      onConfirm={async () => {
        if (!projectId) return;
        try {
          const removal = await api.removeProject(projectId, acknowledged);
          if (removal.kept_path) onKept(`${name} is removed. Its files stay at ${removal.kept_path}.`);
          onClose();
          dropProject(projectId);
          await refreshManaged();
        } catch (failure) {
          if (failure instanceof ApiFailure && failure.code === "project_has_work") {
            setManagedWork(failure.message);
            return;
          }
          throw failure;
        }
      }}
    >
      <p>Deletes the project entry and its threads. Files on disk are not touched.</p>
      {managedWork ? (
        <>
          <p className="banner banner-warn">
            <TriangleAlert size={16} aria-hidden />
            {managedWork}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>Remove it anyway</span>
          </label>
        </>
      ) : null}
    </ConfirmDialog>
  );
}

const PERMISSIONS = [
  { value: "supervised", label: "Supervised" },
  { value: "auto_edits", label: "Auto-accept edits" },
  { value: "auto", label: "Auto" },
  { value: "full_access", label: "Full access" },
];

function EngineToggles({ value, save }: { value: unknown; save(next: string[]): void }) {
  const engines = useWorkspace((state) => state.engines.data) ?? [];
  const off = Array.isArray(value) ? (value as string[]) : [];
  return (
    <div className="engine-toggles">
      {engines.map((engine) => (
        <label key={engine.id} className="check">
          <input
            type="checkbox"
            checked={!off.includes(engine.id)}
            onChange={(event) => save(event.target.checked ? off.filter((id) => id !== engine.id) : [...off, engine.id])}
          />
          <span>{engine.name}</span>
        </label>
      ))}
    </div>
  );
}

/** One command per line, saved as the scripts new threads in this project offer. */
type ScriptDraft = Partial<ProjectScript> & { name: string; command: string };
function ScriptLines({ value, save }: { value: unknown; save(next: ScriptDraft[]): void }) {
  const scripts = Array.isArray(value) ? (value as ScriptDraft[]) : [];
  return (
    <textarea
      aria-label="Project scripts"
      rows={3}
      placeholder="Name: command"
      key={JSON.stringify(scripts)}
      defaultValue={scripts.map((script) => `${script.name}: ${script.command}`).join("\n")}
      onBlur={(event) =>
        save(
          event.target.value
            .split("\n")
            .map((line) => /^([^:]+):\s*(.+)$/.exec(line.trim()))
            .flatMap((match) => {
              if (!match) return [];
              const name = match[1] ?? "";
              return [{ ...scripts.find((script) => script.name === name), name, command: match[2] ?? "" }];
            }),
        )
      }
    />
  );
}

/** What this project sets for itself. Anything left alone follows the global setting. */
function ProjectSettingsDialog({ projectId, name, onClose }: { projectId: string; name: string; onClose(): void }) {
  return (
    <Dialog title={`${name} settings`} onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <PreferenceGroups
        projectId={projectId}
        groups={[
          {
            title: "New threads",
            rows: [
              { key: "default_engine", title: "Default engine", inheritance: true },
              { key: "default_model", title: "Default model", inheritance: true },
              { key: "default_permission_mode", title: "Default permissions", options: PERMISSIONS, inheritance: true },
              {
                key: "project_title_instructions",
                title: "Title instructions",
                description: "Used instead of the global instructions in this project.",
              },
              {
                key: "default_thread_env_mode",
                inheritance: true,
                title: "Default checkout",
                options: [
                  { value: "local", label: "Current checkout" },
                  { value: "worktree", label: "New worktree" },
                ],
              },
              {
                key: "disabled_engines",
                title: "Providers",
                render: (value, save) => <EngineToggles value={value} save={save} />,
              },
              {
                key: "default_project_scripts",
                title: "Scripts",
                render: (value, save) => <ScriptLines value={value} save={save} />,
              },
            ],
          },
          {
            title: "Source control",
            rows: [
              { key: "auto_pull", title: "Pull the default branch automatically", inheritance: true },
              {
                key: "worktree_submodules",
                inheritance: true,
                title: "Submodules",
                options: [
                  { value: "recursive", label: "Recursive" },
                  { value: "top-level", label: "Top level only" },
                  { value: "none", label: "Skip" },
                ],
              },
            ],
          },
        ]}
      />
    </Dialog>
  );
}

function TargetRow({ target, onKept }: { target: TargetStatus; onKept(note: string): void }) {
  const name = useWorkspace(
    (state) =>
      state.projects.data?.find((project) => project.id === target.project_id)?.name ??
      target.path.split(/[\\/]/).filter(Boolean).at(-1) ??
      target.path,
  );
  const [removing, setRemoving] = useState(false);
  const [configuring, setConfiguring] = useState(false);

  return (
    <li className="setting-row">
      <div className="engine-row-head">
        <h3>{name}</h3>
        {target.dirty ? <Pill tone="warn">Modified</Pill> : null}
        {target.project_id ? (
          <span className="engine-row-actions">
            <Button
              small
              tone="quiet"
              aria-label={`Settings for ${name}`}
              icon={<Settings2 size={16} aria-hidden />}
              onClick={() => setConfiguring(true)}
            />
            <Button
              small
              tone="quiet"
              aria-label={`Remove ${name}`}
              icon={<Trash2 size={16} aria-hidden />}
              onClick={() => setRemoving(true)}
            />
          </span>
        ) : null}
      </div>
      <dl className="facts">
        <div>
          <dt>Git root</dt>
          <dd>
            <code>{target.git_root ?? target.path}</code>
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>
            <code>{short(target.revision)}</code>
          </dd>
        </div>
        {target.branch ? (
          <div>
            <dt>Branch</dt>
            <dd>{target.branch}</dd>
          </div>
        ) : null}
        <div>
          <dt>Worktrees</dt>
          <dd>{target.worktrees.length}</dd>
        </div>
      </dl>
      {target.worktrees.length > 0 ? (
        <ul className="plain-list">
          {target.worktrees.map((worktree) => (
            <li key={worktree.path}>
              <code>{worktree.branch ?? short(worktree.revision)}</code>{" "}
              <span className="muted">{worktree.path}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {target.problem ? <p className="banner banner-warn">{target.problem}</p> : null}
      {removing ? (
        <RemoveDialog target={target} name={name} onClose={() => setRemoving(false)} onKept={onKept} />
      ) : null}
      {configuring && target.project_id ? (
        <ProjectSettingsDialog projectId={target.project_id} name={name} onClose={() => setConfiguring(false)} />
      ) : null}
    </li>
  );
}

export function ProjectsSection() {
  const managed = useWorkspace((state) => state.managed);
  const unsupported = useWorkspace((state) => state.managedUnsupported);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const [keptNote, setKeptNote] = useState<string | null>(null);
  const targets = (managed.data?.targets ?? []).filter((target) => target.path !== managed.data?.library?.path);

  return (
    <>
      <div className="section-bar">
        <h1 className="sr-only" tabIndex={-1} data-page-title>
          Projects
        </h1>
      </div>
      {unsupported ? (
        <Empty title="No projects yet" />
      ) : managed.error && !managed.data ? (
        <ErrorState title="Couldn't load projects" failure={managed.error} onRetry={() => void refreshManaged()} />
      ) : !managed.data ? (
        <Loading label="Loading projects" />
      ) : (
        <>
          <section className="section">
            <h2>Projects</h2>
            {keptNote ? (
              <p className="banner banner-warn" role="status">
                {keptNote}
              </p>
            ) : null}
            {targets.length === 0 ? (
              <Empty title="No projects yet" />
            ) : (
              <ul className="setting-list">
                {targets.map((target) => (
                  <TargetRow key={target.path} target={target} onKept={setKeptNote} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
