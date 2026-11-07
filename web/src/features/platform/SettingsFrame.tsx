import type { ReactNode } from "react";
import { PlatformFrame } from "./Unavailable";

const SECTIONS = ["General", "Appearance", "Chat", "Providers", "Threads", "Projects", "Source control", "Remote access", "Labs", "About"];

/** The Settings page layout with a static section list; nothing in it navigates. */
export function SettingsFrame({ active, title, children }: { active: string; title: string; children: ReactNode }) {
  return (
    <PlatformFrame title="Settings">
      <div className="settings-page platform-settings">
        <div className="settings-side">
          <ul className="platform-sections" aria-label="Settings sections (sample)">
            {SECTIONS.map((name) => (
              <li key={name} aria-current={name === active ? "page" : undefined}>
                {name}
              </li>
            ))}
          </ul>
        </div>
        <div className="settings-body platform-settings-body">
          <h2 className="platform-title">{title}</h2>
          {children}
        </div>
      </div>
    </PlatformFrame>
  );
}
