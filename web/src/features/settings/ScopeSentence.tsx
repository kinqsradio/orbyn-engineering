import { api } from "../../api/client";
import { useAsync } from "../../lib/useAsync";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../ui/controls";
import { useSettingsScope } from "./SettingsScopeContext";

interface Choice { key: string; label: string; path?: string; }

function ScopePicker({ axis, label, value, options, allLabel, disabled, onSelect }: {
  axis: "Project" | "Checkout";
  label: string;
  value: string | undefined;
  options: Choice[];
  allLabel: string;
  disabled: boolean;
  onSelect(value: string | undefined): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const tabClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(tabClose.current), []);
  const searchable = options.length > 6;
  const choices: Choice[] = [{ key: "", label: allLabel }, ...options];
  const needle = query.trim().toLocaleLowerCase();
  const visible = choices.filter((choice) => `${choice.label} ${choice.path ?? ""}`.toLocaleLowerCase().includes(needle));
  const close = (restoreFocus = true) => {
    setOpen(false); setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };
  const choose = (choice: Choice) => { onSelect(choice.key === "" ? undefined : choice.key); close(); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const element = popup.current;
      if (!anchor || !element) return;
      const bounds = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - bounds.height - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, query]);
  useEffect(() => {
    if (!open) return;
    if (searchable) search.current?.focus();
    else (popup.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? popup.current?.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) {
        setOpen(false); setQuery("");
      }
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open, searchable]);

  return <>
    <button ref={trigger} type="button" className="btn btn-small" disabled={disabled}
      aria-label={`${axis} scope: ${label}`} aria-haspopup={searchable ? "listbox" : "menu"} aria-expanded={open}
      onClick={() => { clearTimeout(tabClose.current); setOpen(!open); setHighlight(Math.max(0, choices.findIndex((choice) => choice.key === (value ?? "")))); }}>
      {label}<ChevronDown size={14} aria-hidden />
    </button>
    {open ? (
      <div ref={popup} className="popup-menu" style={{ width: "min(320px, calc(100vw - 16px))", maxHeight: "min(400px, calc(100dvh - 24px))", overflowY: "auto" }}
        role={searchable ? "dialog" : "menu"} aria-label={`${axis} scope`}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
          else if (event.key === "Tab") {
            // Let native Tab move focus before removing the focused popup node.
            tabClose.current = setTimeout(() => close(false), 0);
          }
          else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = (highlight + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % Math.max(1, visible.length);
            setHighlight(next);
            if (!searchable) popup.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")[next]?.focus();
          } else if (event.key === "Enter" && searchable && visible[highlight]) { event.preventDefault(); choose(visible[highlight]); }
        }}>
        {searchable ? <input ref={search} role="combobox" aria-label={`Search ${axis === "Project" ? "projects" : "checkouts"}`}
          placeholder={`Search ${axis === "Project" ? "projects" : "checkouts"}`} value={query}
          aria-expanded="true" aria-controls={listId} aria-activedescendant={visible[highlight] ? `${listId}-${highlight}` : undefined}
          onChange={(event) => { setQuery(event.target.value); setHighlight(0); }} /> : null}
        <div id={listId} role={searchable ? "listbox" : "group"} aria-label={axis === "Project" ? "Projects" : "Checkouts"}>
          {visible.map((choice, index) => (
            <button key={choice.key} id={`${listId}-${index}`} type="button" role={searchable ? "option" : "menuitemradio"}
              aria-selected={searchable ? (value ?? "") === choice.key : undefined}
              aria-checked={!searchable ? (value ?? "") === choice.key : undefined}
              tabIndex={!searchable && index === highlight ? 0 : -1}
              style={{ width: "100%", display: "flex", gap: 8, textAlign: "left", padding: 8, background: index === highlight ? "var(--color-hover)" : undefined }}
              onPointerMove={() => setHighlight(index)} onFocus={() => setHighlight(index)} onClick={() => choose(choice)}>
              <span style={{ flex: 1, overflowWrap: "anywhere" }}>{choice.label}{choice.path ? <small style={{ display: "block" }}>{choice.path}</small> : null}</span>
              {(value ?? "") === choice.key ? <Check size={14} aria-hidden /> : null}
            </button>
          ))}
          {!visible.length ? <p role="status">No matches found.</p> : null}
        </div>
      </div>
    ) : null}
  </>;
}

function LocalEnvironmentLabel() {
  const info = useAsync("settings-environment-label", (signal) => api.info(signal));
  if (info.error) return <span role="alert">{info.error.message} <Button small onClick={info.reload}>Retry</Button></span>;
  return <span>{info.data?.environment_label ?? "Loading…"}</span>;
}

/** The local project/checkouts axis; remote environment choices are outside this app's scope. */
export function ScopeSentence() {
  const scope = useSettingsScope();
  if (!scope?.active) return null;
  const groups = scope.catalog?.groups ?? [];
  const selection = scope.query.selection;
  const groupKey = selection?.kind === "project_group" || selection?.kind === "checkout" ? selection.group_key : undefined;
  const selected = groups.find((group) => group.key === groupKey);
  const unavailable = scope.catalog?.selection.kind === "unavailable";
  const checkoutSelection = selection?.kind === "checkout" ? selection : undefined;
  const checkout = checkoutSelection ? selected?.members.find((member) => member.project_id === checkoutSelection.project_id) : undefined;
  const missing = groupKey !== undefined && (!selected || (checkoutSelection && !checkout));
  const projectLabel = unavailable || missing ? "Unavailable project" : checkout?.name ?? selected?.label ?? "All projects";
  // A checkout reached through provenance is narrower than its parent group.
  // Do not mark that group's menu option selected until it is explicitly chosen.
  const pickerValue = checkoutSelection ? checkout?.physical_key ?? `unavailable:${checkoutSelection.project_id}` : groupKey;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <span>Applying settings for</span>
        <ScopePicker axis="Project" label={scope.loading ? "Loading projects…" : projectLabel} value={pickerValue}
          disabled={scope.loading || !scope.catalog} allLabel="All projects"
          options={groups.map((group) => ({ key: group.key, label: group.label,
            path: groups.some((other) => other.key !== group.key && other.label === group.label) ? group.members[0]?.path ?? group.members[0]?.name : undefined }))}
          onSelect={(key) => scope.select(key === undefined ? undefined : { kind: "project_group", group_key: key })} />
        <span>on</span><LocalEnvironmentLabel />

      </div>
      {scope.error ? <p role="alert">{scope.error.message} <Button small onClick={scope.reload}>Retry</Button></p> : null}
      {unavailable ? <p role="status">This selection is no longer available. Choose a project or checkout to continue.</p> : null}
    </div>
  );
}
