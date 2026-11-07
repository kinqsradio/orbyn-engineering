import { useState } from "react";
import { PreferenceGroups } from "./PreferenceRows";
import { settingsLabel } from "./settingsSearch";

interface WritingStyle {
  mode: "repo_conventions" | "conventional_commits" | "custom";
  custom_instructions: string;
  follow_templates: boolean;
}

export function WritingStyleControl({ value, save, mixed = false }: { value: unknown; save(value: WritingStyle): void; mixed?: boolean }) {
  const stored = (value && typeof value === "object" ? value : {}) as Partial<WritingStyle>;
  const [style, setStyle] = useState<WritingStyle>({ mode: stored.mode ?? "repo_conventions",
    custom_instructions: stored.custom_instructions ?? "", follow_templates: stored.follow_templates ?? true });
  const change = (next: WritingStyle) => { setStyle(next); save(next); };
  return <div>
    <select aria-label="Source control writing style" value={mixed ? "mixed" : style.mode} onChange={(event) => change({ ...style, mode: event.target.value as WritingStyle["mode"] })}>
      {mixed ? <option value="mixed" disabled>Mixed</option> : null}
      <option value="repo_conventions">Repository conventions</option>
      <option value="conventional_commits">Conventional Commits</option>
      <option value="custom">Custom instructions</option>
    </select>
    {style.mode === "custom" && !mixed ? <textarea aria-label="Custom source control writing instructions" rows={3} maxLength={8000}
      value={style.custom_instructions} onChange={(event) => setStyle({ ...style, custom_instructions: event.target.value })}
      onBlur={() => save(style)} /> : null}
    <label className="check"><input type="checkbox" role="switch" aria-label="Follow change request templates"
      checked={!mixed && style.follow_templates} aria-checked={mixed ? "mixed" : style.follow_templates}
      onChange={(event) => change({ ...style, follow_templates: event.target.checked })} />Follow change request templates</label>
  </div>;
}

export function SourceControlWriting() {
  return <PreferenceGroups groups={[{ title: "", rows: [{ key: "source_control_writing_style", title: settingsLabel("source-control-writing-style"),
    description: "How generated commit messages read",
    render: (value, save, control) => <WritingStyleControl value={value} mixed={control.mixed} save={save} />,
  }] }]} />;
}
