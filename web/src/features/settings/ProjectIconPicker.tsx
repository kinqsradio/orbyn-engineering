import { useLayoutEffect, useRef, useState } from "react";
import type { ProjectIconOverride } from "../../generated/ProjectIconOverride";
import { deriveProjectIdentity, PROJECT_ICON_COLORS, type ProjectIconColor } from "../../lib/projectIdentity";
import { toFailure } from "../../lib/useAsync";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/controls";
import { ProjectIconVisual } from "./ProjectIconVisual";
import { emojiChoices, iconChoiceLabel, pastedProjectEmoji, pickerMonogram, searchProjectIcons } from "./projectIconChoices";
import "./ProjectIconPicker.css";

/** Mounted once per open: read revisions may rebase while the user's draft stays local. */
export function ProjectIconPicker({ current, projectName, disabled, onClose, onSave, onReload, reloadPending }: {
  current: ProjectIconOverride | null;
  projectName: string;
  disabled: boolean;
  onClose(): void;
  onSave(icon: ProjectIconOverride): Promise<void>;
  onReload?: () => void;
  reloadPending?: boolean;
}) {
  const automatic = deriveProjectIdentity(projectName);
  const [kind, setKind] = useState<ProjectIconOverride["kind"]>(current?.kind ?? "lucide");
  const [name, setName] = useState(current?.kind === "lucide" ? current.name : "folder-code");
  const [color, setColor] = useState<ProjectIconColor>(current && current.kind !== "emoji" ? current.color : automatic.color);
  const [letters, setLetters] = useState(current?.kind === "monogram" ? current.text : automatic.monogram);
  const [emoji, setEmoji] = useState(current?.kind === "emoji" ? current.emoji : "💻");
  const [query, setQuery] = useState("");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const monogram = pickerMonogram(letters);
  const names = searchProjectIcons(query);
  const submit = async () => {
    if (pending.current || disabled || (kind === "monogram" && !monogram.valid)) return;
    pending.current = true; setBusy(true); setError(null);
    const icon: ProjectIconOverride = kind === "lucide" ? { kind, name, color } : kind === "emoji" ? { kind, emoji } : { kind, text: monogram.text, color };
    try {
      await onSave(icon);
      if (mounted.current) onClose();
    } catch (failure) {
      if (mounted.current) setError(toFailure(failure).message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <Dialog title="Choose project icon" busy={busy} onClose={onClose} footer={<>
    <Button onClick={onClose} disabled={busy}>Cancel</Button>
    <Button tone="primary" onClick={() => { void submit(); }} busy={busy} disabled={disabled || (kind === "monogram" && !monogram.valid)}>Save icon</Button>
  </>}>
    <div className="project-icon-picker">
      <p className="setting-line-desc">Choose an icon, emoji, or monogram.</p>
      <div className="project-icon-kinds" role="group" aria-label="Icon type">
        {([['lucide', 'Icons'], ['emoji', 'Emoji'], ['monogram', 'Monogram']] as const).map(([value, label]) =>
          <Button key={value} aria-pressed={kind === value} disabled={busy} onClick={() => setKind(value)}>{label}</Button>)}
      </div>
      {kind !== "emoji" ? <div><div className="project-icon-hint">Color</div>
        <div className="project-icon-colors" role="group" aria-label="Icon color">
          {PROJECT_ICON_COLORS.map((value) => <button key={value} type="button" aria-label={iconChoiceLabel(value)} aria-pressed={color === value}
            className={`project-color-${value}`} disabled={busy} onClick={() => setColor(value)}><span /></button>)}
        </div>
      </div> : null}
      {kind === "lucide" ? <>
        <input type="search" aria-label="Search Lucide icons" placeholder="Search all Lucide icons" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
        <div className="project-icon-options" role="group" aria-label="Icons">
          {names.map((value) => <button key={value} type="button" aria-label={iconChoiceLabel(value)} aria-pressed={name === value} disabled={busy} onClick={() => setName(value)}>
            <ProjectIconVisual icon={{ kind: "lucide", name: value, color }} />
          </button>)}
        </div>
        {names.length === 0 ? <p className="project-icon-empty">No icons found.</p> : null}
      </> : kind === "emoji" ? <>
        <div className="project-icon-options" role="group" aria-label="Emoji">
          {emojiChoices.map(([value, label]) => <button key={value} type="button" aria-label={label} aria-pressed={emoji === value} disabled={busy} onClick={() => setEmoji(value)}>{value}</button>)}
        </div>
        <label className="project-icon-hint">Or paste any emoji<input aria-label="Custom emoji" placeholder="Paste an emoji" value={pasted} disabled={busy} onChange={(event) => {
          const value = event.target.value; setPasted(value); const next = pastedProjectEmoji(value); if (next) setEmoji(next);
        }} /></label>
      </> : <div className="project-icon-letters">
        <ProjectIconVisual size={48} icon={{ kind: "monogram", text: monogram.valid ? monogram.text : automatic.monogram, color }} />
        <label>Letters<input aria-label="Letters" aria-describedby="project-monogram-hint" aria-invalid={!monogram.valid} autoComplete="off" value={letters} disabled={busy} onChange={(event) => setLetters(event.target.value)} />
          <span id="project-monogram-hint" className="project-icon-hint">One or two letters or numbers.</span></label>
      </div>}
      {error ? <p role="alert" className="field-error">{error}</p> : null}
      {onReload ? <Button disabled={busy || reloadPending} onClick={onReload}>Reload</Button> : null}
    </div>
  </Dialog>;
}
