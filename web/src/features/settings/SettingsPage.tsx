import { SCOPE_LINE_SECTIONS, SettingsScopeProvider } from "./SettingsScopeContext";
import { ScopeSentence } from "./ScopeSentence";
import { SettingRowIds } from "../../ui/SettingRow";
import { searchSettings, settingSearchId } from "./settingsSearch";
import { api } from "../../api/client";
import { onShellChange } from "../../api/shell";
import { useAsync } from "../../lib/useAsync";
import { navigate, useRoute } from "../../state/route";
import { Info, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { routeHref, type SettingsSection } from "../../state/route";
import { IconButton } from "../../ui/controls";
import { AppearanceSection } from "./Appearance";
import { KeybindingsSection } from "./Keybindings";
import { MaintenanceSection } from "./Maintenance";
import { ProjectsSection } from "./Projects";
import { ProvidersSection } from "./Providers";
import {
  AboutSection,
  ArchiveSection,
  ChatSection,
  DiffsSection,
  GeneralSection,
  LabsSection,
  SourceControlSection,
  WorktreesSection,
} from "./PreferenceSections";
import { ScheduledTasksSection } from "./ScheduledTasks";
import { ThreadsSection } from "./Threads";
import "./settingsDesign.css";

export const labels: Record<SettingsSection, string> = {
  general: "General",
  appearance: "Appearance",
  chat: "Chat",
  diffs: "Diffs & pull requests",
  keybindings: "Keybindings",
  providers: "Providers",
  threads: "Threads",
  tasks: "Scheduled tasks",
  projects: "Projects",
  "source-control": "Source control",
  worktrees: "Worktrees",
  maintenance: "Maintenance",
  labs: "Labs",
  about: "About",
  archive: "Archive",
};

/** The reference product's order. Sections without a backend here stay out. */
const groups: { label: string | null; sections: SettingsSection[] }[] = [
  { label: null, sections: ["general", "appearance", "chat", "diffs", "keybindings"] },
  { label: "Agents", sections: ["providers", "threads", "tasks"] },
  { label: "Code", sections: ["projects", "source-control", "worktrees"] },
  { label: null, sections: ["maintenance", "labs", "about", "archive"] },
];

const views: Record<SettingsSection, () => React.JSX.Element | null> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  chat: ChatSection,
  diffs: DiffsSection,
  tasks: ScheduledTasksSection,
  "source-control": SourceControlSection,
  worktrees: WorktreesSection,
  labs: LabsSection,
  about: AboutSection,
  archive: ArchiveSection,
  keybindings: KeybindingsSection,
  providers: ProvidersSection,
  threads: ThreadsSection,
  projects: ProjectsSection,
  maintenance: MaintenanceSection,
};

/** Settings fill the main area of the frame: a section list on the left, the open section on the right. */
export function SettingsPage({ section, onClose }: { section: SettingsSection | null; onClose(): void }) {
  return <SettingsScopeProvider section={section ?? "general"}><SettingsPageContent section={section} onClose={onClose} /></SettingsScopeProvider>;
}

function SettingsPageContent({ section, onClose }: { section: SettingsSection | null; onClose(): void }) {
  const route = useRoute();
  const sectionRoute = (next: SettingsSection) => ({ name: "settings" as const, section: next, selection: route.name === "settings" ? route.selection : undefined, machine: route.name === "settings" ? route.machine : undefined });
  const ref = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<{ id: string } | null>(null);
  const shell = useAsync("settings-search-shell", (signal) => api.shell(signal));
  const current = section ?? "general";
  const View = views[current];

  // Escape closes settings from anywhere, unless a dialog, menu or field is handling its own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog owns Escape even when its focused button has just been disabled and focus fell to the page.
      if (document.querySelector("dialog[open]")) return;
      const target = event.target;
      if (target instanceof Element) {
        if (target.closest('dialog[open], [role="dialog"], [role="menu"], [role="listbox"], [role="combobox"], [contenteditable="true"]')) return;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
        if (target instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(target.type)) return;
      }
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sectionResults = groups.flatMap((group) => group.sections).filter((entry) => labels[entry].toLowerCase().includes(query.trim().toLowerCase()));
  const reloadShell = shell.reload;
  useEffect(() => onShellChange(reloadShell), [reloadShell]);
  const results = useMemo(() => {
    const available = new Set<"cli" | "accessibility" | "screen_recording">();
    if (shell.data?.facts?.cli) available.add("cli");
    for (const permission of shell.data?.facts?.permissions ?? []) {
      if (permission.id === "accessibility" || permission.id === "screen_recording") available.add(permission.id);
    }
    return searchSettings(query, shell.data?.attached === true, available);
  }, [query, shell.data]);

  useEffect(() => {
    if (!target) return;
    const page = ref.current;
    if (!page) return;
    let frame = 0;
    let finished = false;
    const reveal = () => {
      if (finished) return;
      const row = page.querySelector<HTMLElement>(`[id="${target.id}"]`);
      if (!row) return;
      row.dispatchEvent(new Event("reveal-setting", { bubbles: true }));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (row.closest("[hidden]")) return;
        row.scrollIntoView?.({ block: "center" });
        row.focus({ preventScroll: true });
        finished = true;
        observer.disconnect();
      });
    };
    const observer = new MutationObserver(reveal);
    observer.observe(page, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    reveal();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [target, current]);

  // The section list scrolls (down on a short window, sideways on a narrow one), so the open section is kept in view.
  const searching = Boolean(query.trim());
  useEffect(() => {
    if (searching) return;
    ref.current?.querySelector<HTMLElement>('.settings-nav [aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current, searching]);

  return (
    <section
      ref={ref}
      className="settings-page"
      role="region"
      aria-label="Settings"
    >
      <div className="settings-side">
        <div className="settings-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Find a setting"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") ref.current?.querySelector<HTMLElement>(".settings-search-menu a")?.click();
            }}
          />
        </div>
        {searching ? (
          <div className="settings-search-menu" aria-label="Search results">
            {results.length || sectionResults.length ? <>
              {results.length ? <p className="mh">Settings</p> : null}
              {results.map((item) => (
                <a className="settings-search-result" key={item.id} aria-label={`${item.title} · ${labels[item.section]}`} href={routeHref(sectionRoute(item.section))}
                  onClick={(event) => { event.preventDefault(); setTarget({ id: item.id }); navigate({ name: "settings", section: item.section }); }}>
                  <span>{item.title}</span><small>{labels[item.section]}</small>
                </a>
              ))}
              {sectionResults.length ? <p className="mh">Sections</p> : null}
              {sectionResults.map((section) => <a key={section} onClick={() => setTarget(null)} href={routeHref(sectionRoute(section))}>{labels[section]}</a>)}
            </> : <p role="status">No settings found</p>}
          </div>
        ) : null}
        <nav className="settings-nav" aria-label="Settings sections">
          {groups.map((group) => (
            <div key={group.label ?? group.sections[0]} className="settings-group-list">
              {group.label ? <p className="settings-group">{group.label}</p> : null}
              {group.sections.map((entry) => (
                <a
                  key={entry}
                  onClick={() => setTarget(null)}
                  href={routeHref(sectionRoute(entry))}
                  aria-current={entry === current ? "page" : undefined}
                >
                  {labels[entry]}
                </a>
              ))}
            </div>
          ))}
        </nav>
      </div>
      <div className="settings-main">
        <header className="settings-head">
          <span className="settings-title" aria-hidden>{labels[current]}</span>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        </header>
        <div className="settings-scroll">
          <div className="settings-body">
            {SCOPE_LINE_SECTIONS.has(current) ? <ScopeSentence /> : null}
            {current === "general" ? <p className="settings-scope"><Info size={13} aria-hidden />{shell.data?.attached ? "Desktop app · applies to this computer" : "Applies to this computer"}</p> : null}
            {current === "maintenance" ? <p className="settings-scope"><Info size={13} aria-hidden />Applies to this computer</p> : null}
            <SettingRowIds.Provider value={(title) => settingSearchId(current, title)}>
              <View key={current} />
            </SettingRowIds.Provider>
          </div>
        </div>
      </div>
    </section>
  );
}
