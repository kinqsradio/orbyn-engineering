import { ArrowLeft, ChevronRight } from "lucide-react";
import { routeHref, SETTINGS_SECTIONS, type SettingsSection } from "../../state/route";
import { useUi } from "../../state/ui";
import { useLayoutWidth } from "../../lib/useLayout";
import { PageHeader } from "../../ui/states";
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

function SectionNav({ current, list }: { current: SettingsSection | null; list?: boolean }) {
  return (
    <nav className={list ? "settings-list" : "settings-nav"} aria-label="Settings">
      {SETTINGS_SECTIONS.map((section) => (
        <a
          key={section}
          href={routeHref({ name: "settings", section })}
          aria-current={section === current ? "page" : undefined}
        >
          {labels[section]}
          {list ? <ChevronRight size={16} aria-hidden /> : null}
        </a>
      ))}
    </nav>
  );
}

export function SettingsPage({ section }: { section: SettingsSection | null }) {
  const layout = useLayoutWidth();
  const lastThread = useUi((state) => state.lastThreadId);
  const back = lastThread ? { name: "thread" as const, id: lastThread } : { name: "home" as const };
  const backLabel = lastThread ? "Back to thread" : "Threads";

  if (layout === "narrow" && !section) {
    return (
      <div className="page">
        <PageHeader title="Settings" back={back} backLabel={backLabel} />
        <SectionNav current={null} list />
      </div>
    );
  }

  const current = section ?? "engines";
  const View = views[current];
  return (
    <div className="settings">
      {layout === "narrow" ? null : (
        <div className="settings-side">
          <a className="back-link" href={routeHref(back)}>
            {backLabel}
          </a>
          <SectionNav current={current} />
        </div>
      )}
      <div className="settings-main">
        <div className="settings-body">
          {layout === "narrow" ? (
            <a className="back-link" href={routeHref({ name: "settings", section: null })}>
              <ArrowLeft size={16} aria-hidden />
              Settings
            </a>
          ) : null}
          <View key={current} />
        </div>
      </div>
    </div>
  );
}
