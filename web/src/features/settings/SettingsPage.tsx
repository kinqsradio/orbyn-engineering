import { Search, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
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

const labels: Record<SettingsSection, string> = {
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

/** Words a person might search for, beyond the section names. */
const KEYWORDS: Partial<Record<SettingsSection, string>> = {
  general: "notifications sidebar confirmation sound project order thread order",
  appearance: "theme dark light contrast font typography size animation effort color",
  chat: "width timestamp word wrap math send shortcut follow-up steer queue streaming permissions",
  diffs: "pull request merge whitespace",
  keybindings: "shortcut key binding",
  providers: "engine codex claude model sign in install",
  threads: "auto-settle snooze title",
  tasks: "schedule automation webhook",
  projects: "library folder scripts",
  worktrees: "branch naming submodule base directory",
  maintenance: "update diagnostics storage",
};

const matchesSection = (entry: SettingsSection, needle: string) =>
  `${labels[entry]} ${KEYWORDS[entry] ?? ""}`.toLowerCase().includes(needle);

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

/** Settings float over the workspace, which stays as it was underneath. */
export function SettingsPage({ section, onClose }: { section: SettingsSection | null; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const current = section ?? "general";
  const View = views[current];

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        sections: group.sections.filter((entry) => matchesSection(entry, needle)),
      }))
      .filter((group) => group.sections.length > 0);
  }, [query]);

  return (
    <dialog
      ref={ref}
      className="settings-panel"
      aria-label="Settings"
      onCancel={(event) => {
        // A dialog opened from a section reports its own cancel through React too.
        if (event.target !== ref.current) return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="settings-side">
        <div className="settings-search">
          <Search size={14} aria-hidden />
          <input
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <nav className="settings-nav" aria-label="Settings sections">
          {visible.map((group) => (
            <div key={group.label ?? group.sections[0]}>
              {group.label ? <p className="settings-group">{group.label}</p> : null}
              {group.sections.map((entry) => (
                <a
                  key={entry}
                  href={routeHref({ name: "settings", section: entry })}
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
          <span>
            <span className="crumb-project">Settings</span>
            <span className="crumb-slash"> / </span>
            {labels[current]}
          </span>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        </header>
        <div className="settings-scroll">
          <div className="settings-body">
            <View key={current} />
          </div>
        </div>
      </div>
    </dialog>
  );
}
