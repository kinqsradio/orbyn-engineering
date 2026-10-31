import { Search, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { routeHref, type SettingsSection } from "../../state/route";
import { IconButton } from "../../ui/controls";
import { AccessSection } from "./Access";
import { AppearanceSection } from "./Appearance";
import { AuditSection } from "./Audit";
import { ComputerSection } from "./Computer";
import { EnginesSection } from "./Engines";
import { PolicySection } from "./Policy";
import { SkillsSection } from "./Skills";
import { UpdatesSection } from "./Updates";
import { WorkspaceSection } from "./Workspace";

const labels: Record<SettingsSection, string> = {
  engines: "Engines",
  workspace: "Workspace",
  updates: "Updates",
  skills: "Skills",
  policy: "Policy",
  audit: "Audit",
  computer: "Computer",
  access: "Access",
  appearance: "Appearance",
};

const groups: { label: string | null; sections: SettingsSection[] }[] = [
  { label: null, sections: ["appearance", "updates"] },
  { label: "Agents", sections: ["engines", "skills", "policy", "audit"] },
  { label: "Code", sections: ["workspace"] },
  { label: "Connections", sections: ["computer", "access"] },
];

const views: Record<SettingsSection, () => React.JSX.Element | null> = {
  engines: EnginesSection,
  workspace: WorkspaceSection,
  updates: UpdatesSection,
  skills: SkillsSection,
  policy: PolicySection,
  audit: AuditSection,
  computer: ComputerSection,
  access: AccessSection,
  appearance: AppearanceSection,
};

/** Settings float over the workspace, which stays as it was underneath. */
export function SettingsPage({ section, onClose }: { section: SettingsSection | null; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const current = section ?? "engines";
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
        sections: group.sections.filter((entry) => labels[entry].toLowerCase().includes(needle)),
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
            <div key={group.label ?? "general"}>
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
