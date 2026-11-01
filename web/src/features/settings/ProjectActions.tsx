import { Plus, Settings2 } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ProjectScript } from "../../generated/ProjectScript";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";
import { ACTION_ICONS, ProjectActionIcon } from "../../ui/ProjectActionIcon";
import { Button, IconButton } from "../../ui/controls";
import { ConfirmDialog, Dialog } from "../../ui/Dialog";
import type { PreferenceControl, PreferenceSaveResult } from "./PreferenceRows";

function actionsFrom(value: unknown): ProjectScript[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("name" in entry) || !("command" in entry)
      || typeof entry.name !== "string" || typeof entry.command !== "string") return [];
    const fields = entry as Record<string, unknown>;
    return [{ ...fields, name: entry.name, command: entry.command,
      id: typeof fields.id === "string" ? fields.id : null,
      icon: typeof fields.icon === "string" ? fields.icon : null,
      run_on_worktree_create: fields.run_on_worktree_create === true,
      async: fields.async !== false, run_on_settle: fields.run_on_settle === true,
      preview_url: typeof fields.preview_url === "string" ? fields.preview_url : null,
      auto_open_preview: fields.auto_open_preview === true }];
  });
}

const empty = (): ProjectScript => ({ id: null, name: "", command: "", icon: "play", run_on_worktree_create: false,
  async: true, run_on_settle: false, preview_url: null, auto_open_preview: false });

/** The list stays with the scope that supplied its revision and mutation owner. */
export function ProjectActions({ value, control }: { value: unknown; control: PreferenceControl }) {
  const [editing, setEditing] = useState<{ original: string | null; draft: ProjectScript } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!restoreFocus.current || editing || control.disabled) return;
    restoreFocus.current = false;
    // A rename replaces the edit button; Add action remains a useful return target.
    const target = opener.current?.isConnected ? opener.current : root.current?.querySelector("button");
    target?.focus();
  }, [editing, control.disabled]);
  const actions = actionsFrom(value);
  return <div ref={root} className="project-actions">
    <Button small icon={<Plus size={14} aria-hidden />} disabled={control.disabled}
      onClick={(event) => { opener.current = event.currentTarget; setEditing({ original: null, draft: empty() }); }}>Add action</Button>
    {!control.mixed && (actions.length === 0 ? <p className="field-hint">No actions configured.</p> :
      <ul className="project-action-list">{actions.map((action) => <li key={action.name}>
        <ProjectActionIcon icon={action.icon} />
        <div className="project-action-summary"><strong>{action.name}</strong><code>{action.command}</code>
          <span>{action.run_on_worktree_create ? "setup" : ""}{action.run_on_worktree_create && action.run_on_settle ? " · " : ""}{action.run_on_settle ? "on settle" : ""}</span></div>
        <IconButton label={`Edit ${action.name}`} disabled={control.disabled}
          onClick={(event) => { opener.current = event.currentTarget; setEditing({ original: action.name, draft: { ...action } }); }}><Settings2 size={14} aria-hidden /></IconButton>
      </li>)}</ul>)}
    {editing && <ActionDialog key={editing.original ?? "new"} initial={editing.draft} original={editing.original}
      disabled={control.disabled} commit={control.commit} onClose={() => { restoreFocus.current = true; setEditing(null); }} />}
  </div>;
}

function ActionDialog({ initial, original, disabled, commit, onClose }: {
  initial: ProjectScript; original: string | null; disabled: boolean;
  commit(edit: PreferenceEdit): Promise<PreferenceSaveResult>; onClose(): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const picker = useRef<HTMLDetailsElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  // Focus after the child Dialog enters the top layer; earlier focus is inert.
  useLayoutEffect(() => { nameInput.current?.focus(); }, []);
  const change = <K extends keyof ProjectScript>(key: K, value: ProjectScript[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const write = async (edit: PreferenceEdit) => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true); setError(null);
    try {
      const result = await commit(edit);
      if (result.saved) onClose();
      else if (result.error) { setError(result.error); throw new Error(result.error); }
    } finally { pending.current = false; setBusy(false); }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const script = { ...draft, name: draft.name.trim(), command: draft.command.trim(),
      preview_url: draft.preview_url?.trim() || null,
      auto_open_preview: Boolean(draft.preview_url?.trim()) && draft.auto_open_preview,
      async: !draft.run_on_worktree_create || draft.async };
    const edit: PreferenceEdit = original === null ? { op: "add_project_script", script }
      : { op: "update_project_script", name: original, script };
    // The form owns the visible save error; deletion has its confirmation owner.
    void write(edit).catch(() => undefined);
  };
  return <>
    <Dialog title={original === null ? "Add Action" : "Edit Action"} busy={busy} onClose={onClose} footer={<>
      {original !== null && <Button tone="danger" disabled={busy || disabled} onClick={() => setDeleting(true)}>Delete</Button>}
      <Button disabled={busy} onClick={onClose}>Cancel</Button>
      <Button type="submit" form={id} tone="primary" busy={busy} disabled={disabled || !draft.name.trim() || !draft.command.trim()}>
        {original === null ? "Save action" : "Save changes"}</Button>
    </>}>
      <form id={id} onSubmit={submit}>
        <fieldset className="form" disabled={busy || disabled}>
          <div className="field"><label htmlFor={`${id}-name`}>Name</label>
            <div className="project-action-name">
              <details ref={picker} className="project-action-icons" onKeyDown={(event) => {
                if (busy || disabled) { event.preventDefault(); return; }
                if (event.key === "Escape" && picker.current?.open) { event.preventDefault(); event.stopPropagation(); picker.current.open = false; }
              }}><summary aria-label="Choose icon" aria-disabled={busy || disabled} onClick={(event) => { if (busy || disabled) event.preventDefault(); }}><ProjectActionIcon icon={draft.icon} /></summary>
                <div role="group" aria-label="Action icons">{ACTION_ICONS.map((icon) => <button key={icon.value} type="button"
                  aria-label={icon.label} aria-pressed={draft.icon === icon.value} onClick={() => {
                    change("icon", icon.value); if (picker.current) { picker.current.open = false; picker.current.querySelector("summary")?.focus(); }
                  }}><ProjectActionIcon icon={icon.value} /><span>{icon.label}</span></button>)}</div>
              </details>
              <input ref={nameInput} id={`${id}-name`} required value={draft.name} onChange={(event) => change("name", event.target.value)} />
            </div>
          </div>
          <div className="field"><label htmlFor={`${id}-command`}>Command</label>
            <textarea id={`${id}-command`} required rows={3} value={draft.command} onChange={(event) => change("command", event.target.value)} /></div>
          <div className="field"><label htmlFor={`${id}-preview`}>Preview URL (optional)</label>
            <input id={`${id}-preview`} value={draft.preview_url ?? ""} placeholder="http://localhost:5173" onChange={(event) => change("preview_url", event.target.value)} />
            <p className="field-hint">Open this URL in the in-app preview when this action runs.</p></div>
          <label className="check"><input type="checkbox" role="switch" checked={draft.run_on_worktree_create} onChange={(event) => change("run_on_worktree_create", event.target.checked)} />Run automatically on worktree creation</label>
          <label className="check"><input type="checkbox" role="switch" disabled={!draft.run_on_worktree_create} checked={!draft.async} onChange={(event) => change("async", !event.target.checked)} />Wait for it to finish before the agent starts</label>
          <label className="check"><input type="checkbox" role="switch" checked={draft.run_on_settle} onChange={(event) => change("run_on_settle", event.target.checked)} />Run in the thread's worktree when the thread settles</label>
          <label className="check"><input type="checkbox" role="switch" disabled={!draft.preview_url?.trim()} checked={draft.auto_open_preview} onChange={(event) => change("auto_open_preview", event.target.checked)} />Open preview automatically when this action runs</label>
          {error && <p className="field-error" role="alert">{error}</p>}
        </fieldset>
      </form>
    </Dialog>
    {deleting && original !== null && <ConfirmDialog title={`Delete action "${original}"?`} confirmLabel="Delete action" tone="danger" keepOpen
      onClose={() => setDeleting(false)} onConfirm={() => write({ op: "remove_project_script", name: original })}>
      This action cannot be undone.
    </ConfirmDialog>}
  </>;
}
