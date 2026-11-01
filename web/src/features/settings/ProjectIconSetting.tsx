import { RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import type { ProjectIconOverride } from "../../generated/ProjectIconOverride";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import type { ProjectScopeCheckout } from "../../generated/ProjectScopeCheckout";
import type { ProjectScopesQuery } from "../../generated/ProjectScopesQuery";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useWorkspace } from "../../state/workspace";
import { ProjectBadge } from "../../ui/badges";
import { SettingRow } from "../../ui/SettingRow";
import { Button, IconButton } from "../../ui/controls";
import { ProjectIconPicker } from "./ProjectIconPicker";

const hasRevision = (member: ProjectScopeCheckout) => member.metadata_revision !== undefined && /^(0|[1-9][0-9]*)$/.test(member.metadata_revision);
function observed(catalog: ProjectScopeCatalog, members: ProjectScopeCheckout[]) {
  return { source: catalog, membership: catalog.version, revisions: Object.fromEntries(members.map((member) => [member.project_id, member.metadata_revision!])) };
}

export function ProjectIconSetting({ query, catalog, members, projectName, disabled, loading, reload }: {
  query: ProjectScopesQuery;
  catalog: ProjectScopeCatalog;
  members: ProjectScopeCheckout[];
  projectName: string;
  disabled: boolean;
  loading: boolean;
  reload(): void;
}) {
  const [dialog, setDialog] = useState<{ baseline: ReturnType<typeof observed>; current: ProjectIconOverride | null; rebase: boolean; reloadSource: ProjectScopeCatalog | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState<{ source: ProjectScopeCatalog; projects: Project[] } | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const putProject = useWorkspace((state) => state.putProject);
  const projects = useWorkspace((state) => state.projects.data);
  const pushToast = useUi((state) => state.pushToast);
  const writable = !disabled && members.length > 0 && members.every(hasRevision);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    if (!writable) return;
    setDialog((previous) => previous?.rebase && previous.reloadSource !== null && previous.reloadSource !== catalog
      ? { ...previous, baseline: observed(catalog, members), rebase: false, reloadSource: null } : previous);
  }, [catalog, members, writable]);
  const shown = members.map((member) => committed?.source === catalog
    ? committed.projects.find((project) => project.id === member.project_id) ?? member : member);
  const current = shown[0];
  const icon = current?.project_icon ?? null;
  const description = icon?.kind === "lucide" ? `${icon.name} · ${icon.color}` : icon?.kind === "monogram" ? `${icon.text} · ${icon.color}`
    : icon?.kind === "emoji" ? icon.emoji : current?.favicon_path ?? "Automatic";
  const representative = projects?.find((project) => project.id === members[0]?.project_id);
  const preview = representative && current ? { ...representative, project_icon: current.project_icon, favicon_path: current.favicon_path, metadata_revision: current.metadata_revision } : representative;
  const change = async (next: ProjectIconOverride | null, baseline: ReturnType<typeof observed>) => {
    if (!writable || pending.current) return;
    pending.current = true; setSaving(true);
    let refresh = false;
    try {
      const rows = await api.changeProjectIcon({ scope: query, membership_version: baseline.membership, expected_revisions: baseline.revisions, icon: next });
      if (mounted.current) {
        for (const project of rows) putProject(project);
        setCommitted({ source: catalog, projects: rows });
        refresh = true;
      }
    } catch (error) {
      if (mounted.current && toFailure(error).status === 409) {
        setDialog((previous) => previous ? { ...previous, rebase: true, reloadSource: null } : previous);
      }
      throw error;
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
      // Read failure is independent of a known committed metadata change.
      if (refresh && mounted.current) reload();
    }
  };
  return <>
    <SettingRow title="Project icon" description={description} actions={shown.some((member) => member.project_icon || member.favicon_path) ?
      <IconButton label="Reset project icon" disabled={!writable || saving} onClick={() => {
        void change(null, observed(catalog, members)).catch((error: unknown) => { if (mounted.current) pushToast(toFailure(error).message); });
      }}><RotateCcw size={12} aria-hidden /></IconButton> : undefined}>
      <div className="project-icon-control"><ProjectBadge name={projectName} project={preview} />
        <Button small aria-label="Choose a project icon" disabled={!writable || saving} onClick={() => setDialog({ baseline: observed(catalog, members), current: icon, rebase: false, reloadSource: null })}>Choose icon</Button>
      </div>
    </SettingRow>
    {dialog ? <ProjectIconPicker current={dialog.current} projectName={projectName} disabled={!writable || dialog.rebase}
      onClose={() => setDialog(null)} reloadPending={loading} onReload={dialog.rebase ? () => {
        setDialog((previous) => previous ? { ...previous, reloadSource: catalog } : previous);
        reload();
      } : undefined} onSave={(next) => change(next, dialog.baseline)} /> : null}
  </>;
}
