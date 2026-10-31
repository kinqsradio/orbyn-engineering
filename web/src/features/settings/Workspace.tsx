import { Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { LibraryStatus, WorkspaceProject, WorkspaceStatus } from "../../api/workspace";
import { useWorkspace } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Empty, ErrorState, Loading } from "../../ui/states";

const short = (revision: string | null) => revision?.slice(0, 8) ?? "Unknown";

export function FallbackNotice() {
  return (
    <p className="banner banner-warn">
      <TriangleAlert size={16} aria-hidden />
      Skill links weren't created here, so skills reach engines through the fallback route.
    </p>
  );
}

/** Why the library can't change right now; null when it can. */
export function libraryBlock(status: Pick<WorkspaceStatus, "active_runs">, library: LibraryStatus): string | null {
  if (library.modified) return "The library has local changes. Commit or discard them first.";
  if (status.active_runs > 0) {
    return status.active_runs === 1
      ? "1 run is active. Wait for it to finish or cancel it."
      : `${status.active_runs} runs are active. Wait for them to finish or cancel them.`;
  }
  return null;
}

function Library({ status, library }: { status: WorkspaceStatus; library: LibraryStatus }) {
  const putManaged = useWorkspace((state) => state.putManaged);
  const refreshUpdates = useWorkspace((state) => state.refreshUpdates);
  const [dialog, setDialog] = useState<"update" | "rollback" | null>(null);
  const blocked = libraryBlock(status, library);
  const canUpdate = blocked === null && library.behind > 0;

  return (
    <>
      <dl className="facts facts-block">
        <div>
          <dt>Library</dt>
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
          <dd>{library.branch}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd>{library.modified ? <Pill tone="warn">Modified</Pill> : "None"}</dd>
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
            putManaged(await api.updateWorkspace());
            await refreshUpdates();
          }}
        >
          <p>
            {library.incoming.length === 1
              ? "1 incoming commit:"
              : `${library.incoming.length} incoming commits:`}
          </p>
          <ul className="commit-list">
            {library.incoming.map((commit) => (
              <li key={commit.revision}>
                <code>{short(commit.revision)}</code>
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
          onConfirm={async () => putManaged(await api.rollbackWorkspace())}
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

function ProjectRow({ project }: { project: WorkspaceProject }) {
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const dropProject = useWorkspace((state) => state.dropProject);
  const [removing, setRemoving] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const atRisk = project.modified || project.unpushed;

  return (
    <li className="setting-row">
      <div className="engine-row-head">
        <h3>{project.name}</h3>
        {project.modified ? <Pill tone="warn">Modified</Pill> : null}
        {project.unpushed ? <Pill tone="warn">Unpushed</Pill> : null}
        <span className="engine-row-actions">
          <Button
            small
            tone="quiet"
            aria-label={`Remove ${project.name}`}
            icon={<Trash2 size={16} aria-hidden />}
            onClick={() => {
              setAcknowledged(false);
              setRemoving(true);
            }}
          />
        </span>
      </div>
      <dl className="facts">
        <div>
          <dt>Git root</dt>
          <dd>
            <code>{project.git_root}</code>
          </dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>
            <code>{short(project.revision)}</code>
          </dd>
        </div>
        {project.branch ? (
          <div>
            <dt>Branch</dt>
            <dd>{project.branch}</dd>
          </div>
        ) : null}
        <div>
          <dt>Worktrees</dt>
          <dd>{project.worktrees.length}</dd>
        </div>
      </dl>
      {project.worktrees.length > 0 ? (
        <ul className="plain-list">
          {project.worktrees.map((worktree) => (
            <li key={worktree.path}>
              <code>{worktree.branch}</code> <span className="muted">{worktree.path}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {project.overlaps.length > 0 ? (
        <p className="overlap-note">Same name as a library skill: {project.overlaps.join(", ")}</p>
      ) : null}
      {removing ? (
        <RemoveDialog
          project={project}
          atRisk={atRisk}
          acknowledged={acknowledged}
          onAcknowledge={setAcknowledged}
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api.removeProject(project.id, atRisk);
            dropProject(project.id);
            await refreshManaged();
          }}
        />
      ) : null}
    </li>
  );
}

function RemoveDialog({
  project,
  atRisk,
  acknowledged,
  onAcknowledge,
  onClose,
  onConfirm,
}: {
  project: WorkspaceProject;
  atRisk: boolean;
  acknowledged: boolean;
  onAcknowledge(value: boolean): void;
  onClose(): void;
  onConfirm(): Promise<void>;
}) {
  const reasons = [
    project.modified ? "uncommitted changes" : null,
    project.unpushed ? "unpushed commits" : null,
  ].filter(Boolean);
  return (
    <ConfirmDialog
      title={`Remove ${project.name}?`}
      confirmLabel="Remove project"
      tone="danger"
      confirmDisabled={atRisk && !acknowledged}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p>Removes this checkout, its worktrees and its threads from the workspace.</p>
      {atRisk ? (
        <>
          <p className="banner banner-warn">
            <TriangleAlert size={16} aria-hidden />
            This checkout has {reasons.join(" and ")} that exist nowhere else.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => onAcknowledge(event.target.checked)}
            />
            <span>I understand this work will be lost</span>
          </label>
        </>
      ) : null}
    </ConfirmDialog>
  );
}

export function WorkspaceSection() {
  const managed = useWorkspace((state) => state.managed);
  const unsupported = useWorkspace((state) => state.managedUnsupported);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);

  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Workspace
        </h1>
      </div>
      {unsupported ? (
        <Empty title="This service doesn't manage a workspace" />
      ) : managed.error && !managed.data ? (
        <ErrorState title="Couldn't load the workspace" failure={managed.error} onRetry={() => void refreshManaged()} />
      ) : !managed.data ? (
        <Loading label="Loading workspace" />
      ) : (
        <>
          {managed.data.skill_delivery === "fallback" ? <FallbackNotice /> : null}
          {managed.data.library ? <Library status={managed.data} library={managed.data.library} /> : null}
          <section className="section">
            <h2>Projects</h2>
            {managed.data.projects.length === 0 ? (
              <Empty title="No projects yet" />
            ) : (
              <ul className="setting-list">
                {managed.data.projects.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
