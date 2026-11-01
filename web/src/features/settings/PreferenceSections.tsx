import { settingsLabel } from "./settingsSearch";
import { useEffect, useState } from "react";
import { api, request } from "../../api/client";
import type { ForgeStatus, Thread } from "../../api/types";
import { compactAge } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";
import licenses from "./licenses.json";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { unarchiveThread } from "../workspace/threadActions";
import { Menu } from "../../ui/Menu";
import { DETAIL_ROWS, detailsMenuItems } from "../thread/DetailsCard";
import { DesktopApp } from "./DesktopApp";
import { Advanced, PreferenceGroups } from "./PreferenceRows";

const heading = (title: string) => (
  <h1 className="sr-only" tabIndex={-1} data-page-title>
    {title}
  </h1>
);

function Toggle({ title, description, on, set }: { title: string; description?: string; on: boolean; set(on: boolean): void }) {
  return (
    <SettingRow title={title} description={description}>
      <input type="checkbox" role="switch" aria-label={title} checked={on} onChange={(event) => set(event.target.checked)} />
    </SettingRow>
  );
}

function DetailRowsButton() {
  const hidden = useUi((state) => state.detailsHidden);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <Button
        small
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        {DETAIL_ROWS.length - hidden.length} of {DETAIL_ROWS.length} on
      </Button>
      {anchor ? <Menu {...anchor} label="Thread details rows" items={detailsMenuItems()} onClose={() => setAnchor(null)} /> : null}
    </>
  );
}

export function GeneralSection() {
  const working = useUi((state) => state.workingSection);
  const threadSort = useUi((state) => state.threadSort);
  const projectSort = useUi((state) => state.projectSort);
  const notifications = useUi((state) => state.threadNotifications);
  const inApp = useUi((state) => state.inAppNotifications);
  const confirmUnpin = useUi((state) => state.confirmUnpin);
  const confirmArchive = useUi((state) => state.confirmArchive);
  const confirmDelete = useUi((state) => state.confirmDelete);
  const setPrefs = useUi((state) => state.setPrefs);
  const sound = useUi((state) => state.threadSound);
  return (
    <>
      {heading("General")}
      <DesktopApp />
      <SettingGroup title="Notifications">
        <SettingRow
          title={settingsLabel("general-thread-notifications")}
          description="When a thread finishes, fails, or needs input or approval."
        >
          <select
            aria-label="Thread notifications"
            value={notifications ? (sound ? "both" : "alert") : sound ? "sound" : "off"}
            onChange={(event) => {
              const { value } = event.target;
              const alert = value === "alert" || value === "both";
              if (alert && "Notification" in window) void Notification.requestPermission();
              setPrefs({ threadNotifications: alert, threadSound: value === "sound" || value === "both" });
            }}
          >
            <option value="off">Off</option>
            <option value="alert">Notifications</option>
            <option value="sound">Sound</option>
            <option value="both">Notifications and sound</option>
          </select>
        </SettingRow>
        <Toggle
          title={settingsLabel("general-in-app-notifications")}
          description="Show a toast when another thread finishes, fails, or needs input or approval."
          on={inApp}
          set={(on) => setPrefs({ inAppNotifications: on })}
        />
      </SettingGroup>
      <SettingGroup title="Thread details">
        <SettingRow title={settingsLabel("general-rows")} description="Choose what the details card shows. You can also right-click the card.">
          <DetailRowsButton />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Sidebar">
        <Toggle
          title={settingsLabel("general-working-section")}
          description="Threads at work, or waiting on delegated work or a watched pull request, fold into a shelf."
          on={working}
          set={(on) => setPrefs({ workingSection: on })}
        />
        <SettingRow title={settingsLabel("general-project-order")}>
          <select
            aria-label="Project order"
            value={projectSort}
            onChange={(event) => setPrefs({ projectSort: event.target.value as typeof projectSort })}
          >
            <option value="updated_at">Last user message</option>
            <option value="created_at">Created</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("general-thread-order")}>
          <select
            aria-label="Thread order"
            value={threadSort}
            onChange={(event) => setPrefs({ threadSort: event.target.value as typeof threadSort })}
          >
            <option value="updated_at">Last user message</option>
            <option value="created_at">Created</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <PreferenceGroups
        groups={[
          {
            title: "Background activity",
            rows: [
              {
                key: "background_activity_profile",
                title: settingsLabel("general-activity-profile"),
                options: [
                  { value: "balanced", label: "Balanced" },
                  { value: "saver", label: "Saver" },
                  { value: "performance", label: "Performance" },
                ],
              },
              { key: "automatic_git_fetch_minutes", title: settingsLabel("general-git-fetch-interval-minutes") },
              { key: "provider_health_refresh_minutes", title: settingsLabel("general-provider-health-interval-minutes") },
              {
                key: "keep_awake_during_runs",
                title: settingsLabel("general-keep-the-computer-awake-during-runs"),
                description: "In the desktop app. The screen can still sleep.",
              },
            ],
          },
          {
            title: "Providers",
            rows: [
              { key: "enable_provider_update_checks", title: settingsLabel("general-check-providers-for-updates") },
            ],
          },
          {
            title: "New projects",
            rows: [{ key: "add_project_base_directory", title: settingsLabel("general-base-directory") }],
          },
        ]}
      />
      <SettingGroup title="Confirmations">
        <Toggle title={settingsLabel("general-unpin-confirmation")} on={confirmUnpin} set={(on) => setPrefs({ confirmUnpin: on })} />
        <Toggle title={settingsLabel("general-archive-confirmation")} on={confirmArchive} set={(on) => setPrefs({ confirmArchive: on })} />
        <Toggle title={settingsLabel("general-delete-confirmation")} on={confirmDelete} set={(on) => setPrefs({ confirmDelete: on })} />
      </SettingGroup>
    </>
  );
}

export function ChatSection() {
  const math = useUi((state) => state.mathRendering);
  const wordWrap = useUi((state) => state.wordWrap);
  const chatWidth = useUi((state) => state.chatWidth);
  const timestampFormat = useUi((state) => state.timestampFormat);
  const sendShortcut = useUi((state) => state.sendShortcut);
  const followUpBehavior = useUi((state) => state.followUpBehavior);
  const persistent = useUi((state) => state.persistentComposerContext);
  const proactive = useUi((state) => state.proactivePanels);
  const searchEngine = useUi((state) => state.previewSearchEngine);
  const linkTarget = useUi((state) => state.linkTarget);
  const autoFloat = useUi((state) => state.autoFloatPreview);
  const skillsInSlash = useUi((state) => state.skillsInSlashMenu);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Chat")}
      <SettingGroup title="Display">
        <SettingRow title={settingsLabel("chat-chat-width")}>
          <select aria-label="Chat width" value={chatWidth} onChange={(event) => setPrefs({ chatWidth: event.target.value as "comfortable" | "wide" | "full" })}>
            <option value="comfortable">Comfortable</option>
            <option value="wide">Wide</option>
            <option value="full">Full</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("chat-timestamp-format")}>
          <select aria-label="Timestamp format" value={timestampFormat} onChange={(event) => setPrefs({ timestampFormat: event.target.value as "locale" | "12-hour" | "24-hour" })}>
            <option value="locale">System default</option>
            <option value="12-hour">12-hour</option>
            <option value="24-hour">24-hour</option>
          </select>
        </SettingRow>
        <Toggle title={settingsLabel("chat-word-wrap")} on={wordWrap} set={(on) => setPrefs({ wordWrap: on })} />
        <Toggle title={settingsLabel("chat-math-rendering")} on={math} set={(on) => setPrefs({ mathRendering: on })} />
        <Toggle title={settingsLabel("chat-open-changes-after-large-turns")} on={proactive} set={(on) => setPrefs({ proactivePanels: on })} />
      </SettingGroup>
      <SettingGroup title="Browser">
        <SettingRow title={settingsLabel("chat-search-engine")}>
          <select aria-label="Search engine" value={searchEngine} onChange={(event) => setPrefs({ previewSearchEngine: event.target.value })}>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="brave">Brave</option>
            <option value="kagi">Kagi</option>
            <option value="startpage">Startpage</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("chat-open-links-in")} description="For links in a thread.">
          <select aria-label="Open links in" value={linkTarget} onChange={(event) => setPrefs({ linkTarget: event.target.value as "system" | "in-app" })}>
            <option value="system">System browser</option>
            <option value="in-app">Browser panel</option>
          </select>
        </SettingRow>
        <Toggle
          title={settingsLabel("chat-float-pages-agents-open")}
          description="Shows the page over the chat when the Browser panel isn't open."
          on={autoFloat}
          set={(on) => setPrefs({ autoFloatPreview: on })}
        />
      </SettingGroup>
      <SettingGroup title="Composer">
        <Toggle title={settingsLabel("chat-keep-checkout-and-branch-visible")} on={persistent} set={(on) => setPrefs({ persistentComposerContext: on })} />
        <Toggle title={settingsLabel("chat-show-skills-in-the-slash-menu")} on={skillsInSlash} set={(on) => setPrefs({ skillsInSlashMenu: on })} />
        <SettingRow title={settingsLabel("chat-send-shortcut")}>
          <select aria-label="Send shortcut" value={sendShortcut} onChange={(event) => setPrefs({ sendShortcut: event.target.value as "enter" | "mod-enter-multiline" | "mod-enter" })}>
            <option value="enter">Enter</option>
            <option value="mod-enter-multiline">Mod+Enter when multiline</option>
            <option value="mod-enter">Mod+Enter</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("chat-follow-up-behavior")}>
          <select aria-label="Follow-up behavior" value={followUpBehavior} onChange={(event) => setPrefs({ followUpBehavior: event.target.value as "queue" | "steer" })}>
            <option value="queue">Queue</option>
            <option value="steer">Steer</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <PreferenceGroups
        groups={[
          {
            title: "Defaults",
            rows: [
              {
                key: "default_permission_mode",
                title: settingsLabel("chat-default-permissions"),
                options: [
                  { value: "supervised", label: "Supervised" },
                  { value: "auto_edits", label: "Auto-accept edits" },
                  { value: "auto", label: "Auto" },
                  { value: "full_access", label: "Full access" },
                ],
              },
              {
                key: "response_streaming_mode",
                title: settingsLabel("chat-response-streaming"),
                options: [
                  { value: "paragraph", label: "By paragraph" },
                  { value: "turn", label: "When the turn ends" },
                ],
              },
            ],
          },
          {
            title: "Idle threads",
            rows: [
              { key: "compact_idle_threads", title: settingsLabel("chat-compact-idle-threads") },
              {
                key: "idle_compaction",
                title: settingsLabel("chat-idle-compaction"),
                options: [
                  { value: "on_return", label: "On return" },
                  { value: "before_cache_expiry", label: "Before cache expiry" },
                  { value: "never", label: "Never" },
                ],
              },
              { key: "snooze_limited_threads", title: settingsLabel("chat-snooze-until-limits-reset") },
              { key: "auto_resume_limited_threads", title: settingsLabel("chat-resume-after-usage-limits") },
            ],
          },
        ]}
      />
    </>
  );
}

export function DiffsSection() {
  const inApp = useUi((state) => state.pullLinksInApp);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Diffs & pull requests")}
      <SettingGroup title="Links">
        <Toggle
          title={settingsLabel("diffs-open-pull-request-links-here")}
          description="Off opens them on the host."
          on={inApp}
          set={(on) => setPrefs({ pullLinksInApp: on })}
        />
      </SettingGroup>
      <PreferenceGroups
        groups={[
          {
            title: "Pull requests",
            rows: [
              {
                key: "pull_request_merge_method",
                title: settingsLabel("diffs-merge-method"),
                options: [
                  { value: "", label: "Ask" },
                  { value: "merge", label: "Merge" },
                  { value: "squash", label: "Squash" },
                  { value: "rebase", label: "Rebase" },
                ],
              },
              { key: "remove_agent_credits_on_merge", title: settingsLabel("diffs-remove-agent-credits-on-merge") },
            ],
          },
        ]}
      />
    </>
  );
}

export function WorktreesSection() {
  return (
    <>
      {heading("Worktrees")}
      <PreferenceGroups
        groups={[
          {
            title: "New worktrees",
            rows: [
              {
                key: "default_thread_env_mode",
                title: settingsLabel("worktrees-default-checkout"),
                options: [
                  { value: "local", label: "Current checkout" },
                  { value: "worktree", label: "New worktree" },
                ],
              },
              { key: "new_worktrees_start_from_origin", title: settingsLabel("worktrees-start-from-origin") },
              {
                key: "worktree_location",
                title: settingsLabel("worktrees-worktree-location"),
                description: "An absolute folder. Empty keeps them beside the repository. Existing worktrees stay where they are.",
              },
              {
                key: "worktree_submodules",
                title: settingsLabel("worktrees-submodules"),
                options: [
                  { value: "recursive", label: "Recursive" },
                  { value: "top_level", label: "Top level" },
                  { value: "skip", label: "Skip" },
                ],
              },
            ],
          },
        ]}
      />
      <Advanced>
        <PreferenceGroups
          groups={[
            {
              title: "Branch names",
              rows: [
                {
                  key: "branch_naming_mode",
                  title: settingsLabel("worktrees-naming"),
                  options: [
                    { value: "static", label: "Static" },
                    { value: "semantic", label: "Semantic" },
                    { value: "custom", label: "Custom" },
                  ],
                },
                { key: "branch_name_prefix", title: settingsLabel("worktrees-branch-prefix") },
              ],
            },
          ]}
        />
      </Advanced>
    </>
  );
}

export function SourceControlSection() {
  const forges = useAsync("forges", (signal) => request<ForgeStatus[]>("GET", "/api/forges", undefined, signal));
  return (
    <>
      {heading("Source control")}
      {forges.status === "loading" ? (
        <Loading label="Checking source control" rows={3} />
      ) : forges.status === "error" ? (
        <ErrorState title="Couldn't check source control" failure={forges.error} onRetry={forges.reload} />
      ) : (
        <SettingGroup title="Hosts">
          <SettingRow title={settingsLabel("source-control-check-again")} description="Finds a command line tool or sign-in that has changed.">
            <Button small onClick={forges.reload}>
              Rescan
            </Button>
          </SettingRow>
          {forges.data.map((forge) => (
            <SettingRow
              key={forge.id}
              title={forge.name}
              description={forge.problem ?? (forge.accounts.join(", ") || undefined)}
            >
              <Pill tone={forge.signed_in ? "accent" : forge.installed ? "warn" : "neutral"}>
                {forge.signed_in ? "Signed in" : forge.installed ? "Signed out" : "Not installed"}
              </Pill>
            </SettingRow>
          ))}
        </SettingGroup>
      )}
    </>
  );
}

export function LabsSection() {
  const folders = useUi((state) => state.projectFolders);
  const multiline = useUi((state) => state.multilineRows);
  const plan = useUi((state) => state.planControls);
  const meter = useUi((state) => state.contextMeter);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Labs")}
      <SettingGroup title="Sidebar">
        <Toggle
          title={settingsLabel("labs-project-folders")}
          description="Group active threads by project."
          on={folders}
          set={(on) => setPrefs({ projectFolders: on })}
        />
        <Toggle
          title={settingsLabel("labs-multiline-rows")}
          description="Let thread titles in folders wrap."
          on={multiline}
          set={(on) => setPrefs({ multilineRows: on })}
        />
      </SettingGroup>
      <SettingGroup title="Legacy">
        <Toggle
          title={settingsLabel("labs-plan-mode")}
          description="Keeps the Plan button, /plan, /default and Shift+Tab. Off uses Build."
          on={plan}
          set={(on) => setPrefs({ planControls: on })}
        />
        <Toggle
          title={settingsLabel("labs-context-window-indicator")}
          description="Shows how full the context is, as a circle in the composer."
          on={meter}
          set={(on) => setPrefs({ contextMeter: on })}
        />
      </SettingGroup>
    </>
  );
}

function OpenSourceLicenses() {
  const group = (title: string, entries: { name: string; version: string; license: string }[]) => (
    <SettingGroup title={title}>
      {entries.map((entry) => (
        <SettingRow key={entry.name} title={entry.name} description={entry.version}>
          {entry.license}
        </SettingRow>
      ))}
    </SettingGroup>
  );
  return (
    <Advanced>
      {group("Open source in the interface", licenses.scripts)}
      {group("Open source in the service", licenses.crates)}
    </Advanced>
  );
}

export function AboutSection() {
  const info = useAsync("about-info", (signal) => api.info(signal));
  return (
    <>
      {heading("About")}
      <SettingGroup title="Orbyn Engineering">
        <SettingRow title="Version">{info.data?.version ?? "Unknown"}</SettingRow>
        <SettingRow title="Platform">{info.data?.platform ?? "Unknown"}</SettingRow>
      </SettingGroup>
      <OpenSourceLicenses />
    </>
  );
}

export function ArchiveSection() {
  const projects = useVisibleProjects();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projects) return;
    const abort = new AbortController();
    Promise.all(projects.map((project) => api.archivedThreads(project.id, abort.signal))).then(
      (lists) => setThreads(lists.flat().sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
      (failure: unknown) => {
        if (!abort.signal.aborted) setError(toFailure(failure).message);
      },
    );
    return () => abort.abort();
  }, [projects]);
  const remove = async (thread: Thread) => {
    setThreads((threads ?? []).filter((entry) => entry.id !== thread.id));
    await api.deleteThread(thread.id).catch((failure: unknown) => setError(toFailure(failure).message));
  };
  return (
    <>
      {heading("Archive")}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!threads ? (
        <Loading label="Loading archived threads" rows={3} />
      ) : threads.length === 0 ? (
        <Empty title="No archived threads" />
      ) : (
        <SettingGroup title="Archived threads">
          {threads.map((thread) => (
            <SettingRow
              key={thread.id}
              title={thread.title}
              description={`${projects?.find((p) => p.id === thread.project_id)?.name ?? ""} · ${compactAge(thread.updated_at)}`}
            >
              <Button
                small
                onClick={() => {
                  void unarchiveThread(thread);
                  setThreads(threads.filter((entry) => entry.id !== thread.id));
                }}
              >
                Unarchive
              </Button>
              <Button small tone="quiet" onClick={() => void remove(thread)}>
                Delete
              </Button>
            </SettingRow>
          ))}
        </SettingGroup>
      )}
    </>
  );
}
