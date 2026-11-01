import { Info, Trash2, TriangleAlert } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiFailure, api, request } from "../../api/client";
import type { LibraryStatus, Thread } from "../../api/types";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import type { ProjectScopeGroup } from "../../generated/ProjectScopeGroup";
import type { ProjectScopeCheckout } from "../../generated/ProjectScopeCheckout";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useWorkspace } from "../../state/workspace";
import { useUi } from "../../state/ui";
import { PreferenceGroups } from "./PreferenceRows";
import { ProjectActions } from "./ProjectActions";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { Button, Pill } from "../../ui/controls";
import { ConfirmDialog } from "../../ui/Dialog";
import { Loading } from "../../ui/states";

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

type NameRead = {
  catalog: ProjectScopeCatalog;
  label: string;
  expectedNames: Record<string, string>;
};
type NameForm = { read: NameRead; draft: string; dirty: boolean; rebase: boolean };

/** A name draft belongs to the physical members and read that supplied it. */
function ProjectName({ query, catalog, group, members, disabled, reload }: {
  query: ProjectScopesQuery;
  catalog: ProjectScopeCatalog;
  group: ProjectScopeGroup;
  members: ProjectScopeCheckout[];
  disabled: boolean;
  reload(): void;
}) {
  const current = useMemo<NameRead>(() => ({ catalog, label: group.label,
    expectedNames: Object.fromEntries(members.map((member) => [member.project_id, member.name])),
  }), [catalog, group.label, members]);
  const [form, setForm] = useState<NameForm>({ read: current, draft: current.label, dirty: false, rebase: false });
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const putProject = useWorkspace((state) => state.putProject);
  const pushToast = useUi((state) => state.pushToast);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    setForm((previous) => {
      if (previous.read.catalog === current.catalog) return previous;
      if (!previous.dirty) return { read: current, draft: current.label, dirty: false, rebase: false };
      if (!previous.rebase) return previous;
      return { ...previous, read: current, rebase: false };
    });
  }, [current]);
  const busy = disabled || saving || form.rebase;
  const save = async () => {
    if (pending.current || busy || !form.dirty) return;
    const name = form.draft.trim();
    if (!name) { pushToast("Project title cannot be empty"); return; }
    if (name === form.read.label || Object.values(form.read.expectedNames).every((value) => value === name)) {
      setForm({ read: current, draft: current.label, dirty: false, rebase: false });
      return;
    }
    pending.current = true;
    setSaving(true);
    let refresh = false;
    try {
      const projects = await api.renameSelectedProjects({ scope: query, membership_version: form.read.catalog.version,
        expected_names: form.read.expectedNames, name });
      if (mounted.current) {
        for (const project of projects) putProject(project);
        setForm((previous) => ({ read: { ...previous.read, label: name,
          expectedNames: Object.fromEntries(projects.map((project) => [project.id, project.name])) },
          draft: name, dirty: false, rebase: false }));
        refresh = true;
      }
    } catch (error) {
      if (mounted.current) {
        const failure = toFailure(error);
        pushToast(failure.message);
        if (failure.status === 409) {
          setForm((previous) => ({ ...previous, rebase: true }));
          refresh = true;
        }
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
    // A separate read may fail after a known commit; it is never a failed rename.
    if (refresh && mounted.current) reload();
  };
  return <section className="setting-group" aria-label="Project">
    <div className="setting-list"><SettingRow title="Name" description="The shared name for this project group in the sidebar and thread lists.">
      <input aria-label="Project name" value={form.draft} disabled={busy} aria-busy={saving || undefined}
        onChange={(event) => {
          const draft = event.target.value;
          setForm((previous) => draft === previous.read.label
            ? { read: current, draft: current.label, dirty: false, rebase: false }
            : { ...previous, draft, dirty: true });
        }}
        onBlur={() => { void save(); }}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.repeat) {
          event.preventDefault(); event.currentTarget.blur();
        } }} />
    </SettingRow></div>
  </section>;
}

type RemovalPlan = {
  id: number;
  members: ProjectScopeCheckout[];
  counts: Record<string, number>;
  removed: string[];
  wholeGroup: boolean;
  groupLabel: string;
  groupKey: string;
};

/** Registered physical entries own removal; Git worktree inventories do not. */
function ProjectRemoval({ query, group, members, disabled, reload, clearSelection }: {
  query: ProjectScopesQuery;
  group: ProjectScopeGroup;
  members: ProjectScopeCheckout[];
  disabled: boolean;
  reload(): void;
  clearSelection(): void;
}) {
  const environment = useAsync("project-detail-environment", (signal) => api.info(signal));
  const [plan, setPlan] = useState<RemovalPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const pending = useRef(false);
  const deleting = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const countRequest = useRef<AbortController | null>(null);
  const dropProject = useWorkspace((state) => state.dropProject);
  const refreshManaged = useWorkspace((state) => state.refreshManaged);
  const pushToast = useUi((state) => state.pushToast);
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    countRequest.current?.abort();
  }; }, []);
  const begin = async (targets: ProjectScopeCheckout[]) => {
    if (disabled || pending.current || deleting.current || targets.length === 0) return;
    pending.current = true;
    setPlanning(true);
    const abort = new AbortController();
    countRequest.current = abort;
    try {
      const counts = await Promise.all(targets.map(async (member) => {
        const path = `/api/threads?project_id=${encodeURIComponent(member.project_id)}`;
        const lists = await Promise.all([request<Thread[]>("GET", path, undefined, abort.signal),
          request<Thread[]>("GET", `${path}&archived=true`, undefined, abort.signal)]);
        return [member.project_id, new Set(lists.flat().map((thread) => thread.id)).size] as const;
      }));
      if (mounted.current) setPlan({ id: ++sequence.current, members: targets, counts: Object.fromEntries(counts), removed: [],
        wholeGroup: targets.length === group.members.length && group.members.every((member) => targets.some((target) => target.project_id === member.project_id)),
        groupLabel: group.label, groupKey: group.key });
    } catch (error) {
      if (mounted.current) pushToast(toFailure(error).message);
    } finally {
      pending.current = false;
      if (mounted.current) setPlanning(false);
    }
  };
  const remove = async () => {
    if (!plan || disabled || deleting.current) return;
    deleting.current = true;
    try {
      for (const member of plan.members.filter((entry) => !plan.removed.includes(entry.project_id))) {
        try {
          await api.removeProject(member.project_id, false);
        } catch (error) {
          const failure = toFailure(error);
          throw new ApiFailure(failure.code, `Failed to remove "${member.name}": ${failure.message}`, failure.status);
        }
        dropProject(member.project_id);
        if (mounted.current) setPlan((previous) => previous?.id === plan.id
          ? { ...previous, removed: [...previous.removed, member.project_id] } : previous);
      }
      let clear = false;
      if (plan.wholeGroup && mounted.current) {
        try {
          const catalog = await request<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", { recipe: query.recipe });
          clear = !catalog.groups.some((entry) => entry.key === plan.groupKey);
        } catch {
          // Entries are already removed. The independently owned scope read reports
          // its own failure; it must not turn a known removal into a failed mutation.
        }
      }
      if (mounted.current) {
        setPlan(null);
        if (clear) clearSelection();
      }
    } finally {
      deleting.current = false;
      if (mounted.current) {
        reload();
        void refreshManaged();
      }
    }
  };
  const hasOtherMembers = members.length < group.members.length;
  const dangerTitle = hasOtherMembers ? "Remove checkout" : members.length > 1 ? "Remove this project everywhere" : "Remove project";
  const dangerLabel = hasOtherMembers ? "Remove checkout" : members.length > 1 ? "Remove all entries" : "Remove project";
  const remaining = plan?.members.filter((member) => !plan.removed.includes(member.project_id)) ?? [];
  const threadCount = remaining.reduce((count, member) => count + (plan?.counts[member.project_id] ?? 0), 0);
  const targetKind = plan?.wholeGroup ? "project" : "checkout";
  const targetLabel = remaining.length === 1 ? remaining[0]!.name : plan?.groupLabel;
  const question = `Remove ${targetKind} "${targetLabel}"${threadCount > 0 ? ` and delete its ${threadCount} ${threadCount === 1 ? "thread" : "threads"}` : ""}?`;
  return <>
    {members.length > 1 ? <SettingGroup title="Checkouts">
      {members.map((member) => <SettingRow key={member.physical_key} title={environment.data?.environment_label ?? "Environment"} description={member.path ?? undefined}>
        <Button small disabled={disabled || planning} aria-label={`Remove checkout ${member.path}`} onClick={() => { void begin([member]); }}>Remove</Button>
      </SettingRow>)}
    </SettingGroup> : null}
    <SettingGroup title="Danger">
      <SettingRow title={dangerTitle} description={hasOtherMembers
        ? "Deletes the selected machine's checkout entries and their threads. Other machines and files on disk are not touched."
        : members.length > 1 ? `Deletes all ${members.length} checkout entries and their threads on every machine. Files on disk are not touched.`
        : "Deletes the project entry and its threads. Files on disk are not touched."}>
        <Button small tone="danger" icon={<Trash2 size={14} aria-hidden />} disabled={disabled || planning} busy={planning}
          onClick={() => { void begin(members); }}>{dangerLabel}</Button>
      </SettingRow>
    </SettingGroup>
    {plan ? <ConfirmDialog title={question} confirmLabel="Confirm" tone="danger" keepOpen confirmDisabled={disabled || remaining.length === 0}
      onClose={() => setPlan(null)} onConfirm={remove}>
      {remaining.length === 1 ? <><p>Path: {remaining[0]!.path}</p><p>Environment: {environment.data?.environment_label ?? "Environment"}</p></>
        : <p>This removes {remaining.length} grouped project entries.</p>}
      <p>{threadCount > 0 ? "Those threads and any archived threads are deleted from Orbyn. Provider sessions are kept."
        : "Any archived threads are deleted from Orbyn. Provider sessions are kept."}</p>
      <p>{plan.wholeGroup ? "This removes only the project entries, not the files on disk." : "Other entries in this grouped project are unaffected."}</p>
      <p>This action cannot be undone.</p>
    </ConfirmDialog> : null}
  </>;
}

/** Retain a read only within this mounted selection, with all writes disabled on read failure. */
function ProjectSelection() {
  const scope = useSettingsScope();
  const lastCatalog = useRef<ProjectScopeCatalog | null>(null);
  if (scope?.catalog) lastCatalog.current = scope.catalog;
  const catalog = scope?.catalog ?? lastCatalog.current;
  if (!scope) return null;
  // ScopeSentence owns this shared read error and its Retry action.
  if (!catalog) return scope.error ? null : <Loading label="Loading projects" />;
  const selection = catalog.selection;
  let group: ProjectScopeGroup | undefined;
  let members: ProjectScopeCheckout[] = [];
  if (selection.kind === "project_group" || selection.kind === "checkout") {
    group = catalog.groups.find((entry) => entry.key === selection.group_key);
    const ids = selection.kind === "checkout" ? [selection.project_id] : selection.project_ids;
    members = group?.members.filter((member) => ids.includes(member.project_id)) ?? [];
    if (members.length !== ids.length) group = undefined;
  }
  const unavailable = selection.kind === "unavailable" ||
    ((selection.kind === "project_group" || selection.kind === "checkout") && !group);
  const blocked = scope.loading || scope.error !== null || !scope.catalog || members.some((member) =>
    member.unavailable !== null || (!member.metadata_complete && member.grouping_mode !== "separate"));
  return <>
    {unavailable ? <p className="setting-line-desc">{selection.kind === "unavailable" &&
      (selection.reason === "checkout_missing" || selection.reason === "checkout_changed")
        ? "This checkout is no longer available in the selected project and environment."
        : "This project is no longer available."}</p> : !group ?
      <p className="setting-line-desc">Choose a project to manage its name, icon, checkouts and actions.</p> : <>
        <p className="banner"><Info size={16} aria-hidden />Can't find a setting? Keep this project picked above and hop to any other settings page.</p>
        <ProjectName query={scope.query} catalog={catalog} group={group} members={members} disabled={blocked} reload={scope.reload} />
        <fieldset className="preference-control" disabled={blocked}>
          <PreferenceGroups groups={[{ title: "New threads", rows: [{ key: "default_thread_env_mode", title: "Workspace", inheritance: true,
            description: "Where new threads in this project start.", render: (value, save, control) =>
              <select aria-label="Default workspace" disabled={control.disabled} value={control.mixed ? "__mixed__" : String(value ?? "")}
                onChange={(event) => save(event.target.value)}>
                {control.mixed ? <option value="__mixed__" disabled>Mixed</option> : null}
                <option value="local">Current checkout</option><option value="worktree">New worktree</option>
              </select>,
          }] }]} />
          <PreferenceGroups groups={[{ title: "Actions", rows: [{ key: "default_project_scripts", title: "Actions", inheritance: true,
            render: (value, _save, control) => <ProjectActions value={value} control={control} /> }] }]} />
        </fieldset>
        <ProjectRemoval query={scope.query} group={group} members={members} disabled={blocked} reload={scope.reload}
          clearSelection={() => scope.select(undefined)} />
      </>}
  </>;
}

export function ProjectsSection() {
  const scope = useSettingsScope();
  return <>
    <div className="section-bar"><h1 className="sr-only" tabIndex={-1} data-page-title>Projects</h1></div>
    <ProjectSelection key={JSON.stringify(scope?.query ?? {})} />
  </>;
}
