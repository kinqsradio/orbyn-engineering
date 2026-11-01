import { THEME_TOKENS } from "./themes";
import type { SettingsSection } from "../../state/route";

export interface SettingSearchItem {
  id: string;
  title: string;
  section: SettingsSection;
  desktopOnly?: boolean;
  availability?: "cli" | "accessibility" | "screen_recording";
}

/** Labels shared by the actual rows and search; dynamic records are not settings. */
export const SETTINGS: readonly SettingSearchItem[] = [
  {"id": "general-thread-notifications", "title": "Thread notifications", "section": "general"},
  {"id": "general-in-app-notifications", "title": "In-app notifications", "section": "general"},
  {"id": "general-rows", "title": "Rows", "section": "general"},
  {"id": "general-working-section", "title": "Working section", "section": "general"},
  {"id": "general-project-order", "title": "Project order", "section": "general"},
  {"id": "general-thread-order", "title": "Thread order", "section": "general"},
  {"id": "general-activity-profile", "title": "Activity profile", "section": "general"},
  {"id": "general-git-fetch-interval-minutes", "title": "Git fetch interval (minutes)", "section": "general"},
  {"id": "general-provider-health-interval-minutes", "title": "Provider health interval (minutes)", "section": "general"},
  {"id": "general-keep-the-computer-awake-during-runs", "title": "Keep the computer awake during runs", "section": "general"},
  {"id": "general-check-providers-for-updates", "title": "Check providers for updates", "section": "general"},
  {"id": "general-base-directory", "title": "Base directory", "section": "general"},
  {"id": "general-unpin-confirmation", "title": "Unpin confirmation", "section": "general"},
  {"id": "general-archive-confirmation", "title": "Archive confirmation", "section": "general"},
  {"id": "general-delete-confirmation", "title": "Delete confirmation", "section": "general"},
  {"id": "chat-chat-width", "title": "Chat width", "section": "chat"},
  {"id": "chat-timestamp-format", "title": "Timestamp format", "section": "chat"},
  {"id": "chat-word-wrap", "title": "Word wrap", "section": "chat"},
  {"id": "chat-math-rendering", "title": "Math rendering", "section": "chat"},
  {"id": "chat-open-changes-after-large-turns", "title": "Open Changes after large turns", "section": "chat"},
  {"id": "chat-search-engine", "title": "Search engine", "section": "chat"},
  {"id": "chat-open-links-in", "title": "Open links in", "section": "chat"},
  {"id": "chat-float-pages-agents-open", "title": "Float pages agents open", "section": "chat"},
  {"id": "chat-keep-checkout-and-branch-visible", "title": "Keep checkout and branch visible", "section": "chat"},
  {"id": "chat-show-skills-in-the-slash-menu", "title": "Show skills in the slash menu", "section": "chat"},
  {"id": "chat-send-shortcut", "title": "Send shortcut", "section": "chat"},
  {"id": "chat-follow-up-behavior", "title": "Follow-up behavior", "section": "chat"},
  {"id": "chat-default-permissions", "title": "Default permissions", "section": "chat"},
  {"id": "chat-response-streaming", "title": "Response streaming", "section": "chat"},
  {"id": "chat-compact-idle-threads", "title": "Compact idle threads", "section": "chat"},
  {"id": "chat-idle-compaction", "title": "Idle compaction", "section": "chat"},
  {"id": "chat-snooze-until-limits-reset", "title": "Snooze until limits reset", "section": "chat"},
  {"id": "chat-resume-after-usage-limits", "title": "Resume after usage limits", "section": "chat"},
  {"id": "diffs-open-pull-request-links-here", "title": "Open pull request links here", "section": "diffs"},
  {"id": "diffs-merge-method", "title": "Merge method", "section": "diffs"},
  {"id": "diffs-remove-agent-credits-on-merge", "title": "Remove agent credits on merge", "section": "diffs"},
  {"id": "worktrees-default-checkout", "title": "Default checkout", "section": "worktrees"},
  {"id": "worktrees-start-from-origin", "title": "Start from origin", "section": "worktrees"},
  {"id": "worktrees-submodules", "title": "Submodules", "section": "worktrees"},
  {"id": "worktrees-naming", "title": "Naming", "section": "worktrees"},
  {"id": "worktrees-branch-prefix", "title": "Branch prefix", "section": "worktrees"},
  {"id": "source-control-check-again", "title": "Check again", "section": "source-control"},
  {"id": "labs-project-folders", "title": "Project folders", "section": "labs"},
  {"id": "labs-multiline-rows", "title": "Multiline rows", "section": "labs"},
  {"id": "labs-plan-mode", "title": "Plan mode", "section": "labs"},
  {"id": "labs-context-window-indicator", "title": "Context window indicator", "section": "labs"},
  {"id": "appearance-theme-file", "title": "Theme file", "section": "appearance"},
  {"id": "appearance-interface-size", "title": "Interface size", "section": "appearance"},
  {"id": "appearance-chat-size", "title": "Chat size", "section": "appearance"},
  {"id": "appearance-code-size", "title": "Code size", "section": "appearance"},
  {"id": "appearance-terminal-size", "title": "Terminal size", "section": "appearance"},
  {"id": "appearance-interface-font", "title": "Interface font", "section": "appearance"},
  {"id": "appearance-code-font", "title": "Code font", "section": "appearance"},
  {"id": "appearance-theme", "title": "Theme", "section": "appearance"},
  {"id": "appearance-contrast", "title": "Contrast", "section": "appearance"},
  {"id": "appearance-font-smoothing", "title": "Font smoothing", "section": "appearance"},
  {"id": "appearance-effort-display", "title": "Effort display", "section": "appearance"},
  {"id": "threads-add-a-preset", "title": "Add a preset", "section": "threads"},
  {"id": "threads-settle-idle-threads", "title": "Settle idle threads", "section": "threads"},
  {"id": "threads-settle-on-merge", "title": "Settle on merge", "section": "threads"},
  {"id": "threads-title-instructions", "title": "Title instructions", "section": "threads"},
  {"id": "threads-name-new-threads", "title": "Name new threads", "section": "threads"},
  {"id": "threads-title-model", "title": "Title model", "section": "threads"},
  {"id": "maintenance-traces", "title": "Traces", "section": "maintenance"},
  {"id": "maintenance-metrics", "title": "Metrics", "section": "maintenance"},
  {"id": "maintenance-logs", "title": "Logs", "section": "maintenance"},
  {"id": "maintenance-worktrees-days-after-settling", "title": "Worktrees, days after settling", "section": "maintenance"},
  {"id": "maintenance-browser-artifacts-days", "title": "Browser artifacts, days", "section": "maintenance"},
  {"id": "maintenance-logs-days", "title": "Logs, days", "section": "maintenance"},
  {"id": "maintenance-run-the-rules", "title": "Run the rules", "section": "maintenance"},
  {"id": "maintenance-database", "title": "Database", "section": "maintenance"},
  {"id": "maintenance-check-for-updates", "title": "Check for updates", "section": "maintenance"},
  {"id": "maintenance-background-checks", "title": "Background checks", "section": "maintenance"},
  {"id": "general-command-line-tool", "title": "Command line tool", "section": "general", "desktopOnly": true, "availability": "cli"},
  {"id": "appearance-dark-theme", "title": "Dark theme", "section": "appearance"},
  {"id": "appearance-light-theme", "title": "Light theme", "section": "appearance"},
  {"id": "general-accessibility", "title": "Accessibility", "section": "general", "desktopOnly": true, "availability": "accessibility"},
  {"id": "general-screen-recording", "title": "Screen Recording", "section": "general", "desktopOnly": true, "availability": "screen_recording"},
  { id: "appearance-panel-animations", title: "Panel animations", section: "appearance" },
  ...THEME_TOKENS.map(([token, title]) => ({ id: `appearance-color-${token.replace(/^--/, "")}`, title, section: "appearance" as const })),
];

export function settingsLabel(id: string): string {
  const item = SETTINGS.find((entry) => entry.id === id);
  if (!item) throw new Error(`Unknown setting: ${id}`);
  return item.title;
}

export function settingSearchId(section: SettingsSection, title: string): string | undefined {
  return SETTINGS.find((item) => item.section === section && item.title === title)?.id;
}

export function searchSettings(query: string, desktop: boolean, available?: ReadonlySet<SettingSearchItem["availability"]>): readonly SettingSearchItem[] {
  const words = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS.filter((item) => (!item.desktopOnly || desktop) && (!item.availability || !available || available.has(item.availability)) && words.every((word) =>
    `${item.title} ${item.section}`.normalize("NFKC").toLocaleLowerCase().includes(word)));
}
