import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { request } from "../../api/client";
import type { PreferenceView } from "../../api/types";
import type { PreferenceEdit } from "../../generated/PreferenceEdit";
import type { ProjectScopeCatalog } from "../../generated/ProjectScopeCatalog";
import { toFailure, useAsync } from "../../lib/useAsync";
import { ErrorState, Loading } from "../../ui/states";
import { Collapsible } from "../../ui/Collapsible";
import { Check, ChevronRight, Layers } from "lucide-react";
import { Button, IconButton } from "../../ui/controls";
import type { ScopedPreferenceMember } from "../../generated/ScopedPreferenceMember";
import type { ScopedPreferenceOverride } from "../../generated/ScopedPreferenceOverride";
import type { ScopedPreferenceRow } from "../../generated/ScopedPreferenceRow";
import { useSettingsScope } from "./SettingsScopeContext";
import { ScopedRows } from "./ScopedPreferenceRows";

export type PreferenceSaveResult = { saved: true; row: ScopedPreferenceRow | undefined } | { saved: false; error: string | null };
export interface PreferenceControl {
  disabled: boolean;
  mixed: boolean;
  commit(edit: PreferenceEdit): Promise<PreferenceSaveResult>;
}

export interface PreferenceRow {
  key: string;
  title: string;
  description?: string;
  /** Only where the preference response describes the whole inheritance chain. */
  inheritance?: boolean;
  /** Value and label, for a fixed choice. */
  options?: { value: string; label: string }[];
  parse?(value: string): unknown;
  multiline?: boolean;
  /** For a value none of the plain controls fit. */
  render?(value: unknown, save: (next: unknown) => void, control: PreferenceControl): React.ReactNode;
}

/** Settings most people never need, closed until asked for. */
export function Advanced({ children }: { children: React.ReactNode }) {
  return (
    <Collapsible
      summaryClassName="settings-folded-head"
      summary={
        <>
          <ChevronRight size={14} className="chev" aria-hidden />
          <span>Advanced</span>
        </>
      }
    >
      {children}
    </Collapsible>
  );
}

/** Rows backed by the service's preferences. A failed save keeps the saved value. */
export function PreferenceGroups({
  groups,
  projectId,
}: {
  groups: { title: string; rows: PreferenceRow[] }[];
  /** Reads and writes what this project sets over the global value. */
  projectId?: string;
}) {
  const scope = useSettingsScope();
  if (projectId) return <ProjectPreferenceGroups key={projectId} groups={groups} projectId={projectId} />;
  const query = scope?.active ? scope.query : {};
  return <ScopedRows key={JSON.stringify(query)} groups={groups} query={query} />;
}

function ProjectPreferenceGroups({ groups, projectId }: {
  groups: { title: string; rows: PreferenceRow[] }[];
  projectId: string;
}) {
  const catalog = useAsync(`project-preference-scope:${projectId}`, (signal) =>
    request<ProjectScopeCatalog>("POST", "/api/settings/project-scopes", {}, signal));
  if (catalog.status === "loading") return <Loading label="Loading settings" rows={3} />;
  if (catalog.status === "error") return <ErrorState title="Couldn't load settings" failure={catalog.error} onRetry={catalog.reload} />;
  const group = catalog.data.groups.find((candidate) => candidate.members.some((member) => member.project_id === projectId));
  if (!group) return <ErrorState title="Couldn't load settings" failure={toFailure(new Error("This settings scope is unavailable."))} onRetry={catalog.reload} />;
  const query = { selection: { kind: "checkout" as const, group_key: group.key, project_id: projectId } };
  return <ScopedRows key={JSON.stringify(query)} groups={groups} query={query} />;
}

function displayValue(row: PreferenceRow, value: unknown): string {
  const choice = row.options?.find((option) => Object.is(row.parse ? row.parse(option.value) : option.value, value));
  if (choice) return choice.label;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === null || value === undefined) return "Not set";
  if (value === "") return row.key === "default_model" || row.key === "default_engine" ? "Automatic" : "Empty";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  return "Custom";
}

/** A reference-style provenance popover, kept inside the owning modal's top layer. */
export function PreferenceInheritance({ row, view, global, members, overrides, mixed, disabled, onResetOverrides, onOpenOverride }: {
  row: PreferenceRow; view: PreferenceView; global: PreferenceView;
  members?: ScopedPreferenceMember[]; overrides?: ScopedPreferenceOverride[];
  mixed?: boolean; disabled?: boolean;
  onResetOverrides?(ids: string[]): void;
  onOpenOverride?(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const summary = mixed ? "Mixed" : view.source === "project" ? "Overridden for this project" : view.source === "file" ? `Inherited from ${view.project_file?.path ?? "project file"}` : "Inherited from environment";
  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const element = panel.current;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
      const below = anchor.bottom + 4;
      element.style.top = `${Math.max(8, Math.min(below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 4, window.innerHeight - bounds.height - 8))}px`;
    };
    place();
    element.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const layersFor = (view: PreferenceView, environmentOnly: boolean) => [
    ...(!environmentOnly ? [{ label: "Project", value: view.source === "project" ? displayValue(row, view.value) : "Inherits", active: view.source === "project" }] : []),
    { label: "Environment", value: global.source === "global" ? displayValue(row, global.value) : "Inherits", active: view.source === "global" },
    ...(view.project_file ? [{ label: view.project_file.path, value: displayValue(row, view.project_file.value), active: view.source === "file" }] : []),
    { label: "Default", value: displayValue(row, view.default), active: view.source === "default" },
  ];
  const chains = members ? members.length ? members : [{ project_id: null, name: null, view: global }] : [{ project_id: "project", name: null, view }];
  return (
    <div ref={root} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }} onKeyDownCapture={(event) => {
      if (open && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
        trigger.current?.querySelector("button")?.focus();
      }
    }}>
      <div ref={trigger}>
        <IconButton label={`${summary}. Show where this value comes from`} data-overridden={view.source === "project" || undefined} aria-expanded={open}
          aria-controls={open ? id : undefined} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
          <Layers size={12} aria-hidden />
        </IconButton>
      </div>
      {open ? (
        <div ref={panel} id={id} className="setting-inheritance-popup" role="dialog" aria-label={row.title} tabIndex={-1}>
          {chains.map((chain) => <section key={chain.project_id ?? "environment"}>
            {chains.length > 1 ? <p>{chain.name}</p> : null}
            <ol>
              {layersFor(chain.view, chain.project_id === null).map((layer) => (
                <li key={layer.label} aria-current={layer.active || undefined}>
                  <span>{layer.label}</span>
                  <span className="setting-inheritance-value">{layer.value}{layer.active ? <Check size={12} aria-hidden /> : null}</span>
                </li>
              ))}
            </ol>
          </section>)}
          {overrides?.length ? <div className="setting-overrides">
            <div><span>Overridden by</span>
              <Button small tone="quiet" disabled={disabled} onClick={() => onResetOverrides?.(overrides.map((entry) => entry.project_id))}>
                Reset {overrides.length === 1 ? "it" : "all"}
              </Button>
            </div>
            {overrides.map((override) => <div key={override.project_id}>
              <Button small tone="quiet" onClick={() => { onOpenOverride?.(override.project_id); setOpen(false); }}>{override.name}</Button>
              <span>{displayValue(row, override.value)}</span>
            </div>)}
          </div> : null}
        </div>
      ) : null}
    </div>
  );
}
