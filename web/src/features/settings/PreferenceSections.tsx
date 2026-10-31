import { useEffect, useState } from "react";
import { api, request } from "../../api/client";
import type { ForgeStatus, Thread } from "../../api/types";
import { compactAge } from "../../lib/format";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { unarchiveThread } from "../workspace/threadActions";
import { PreferenceGroups } from "./PreferenceRows";

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

export function GeneralSection() {
  const threadSort = useUi((state) => state.threadSort);
  const projectSort = useUi((state) => state.projectSort);
  const notifications = useUi((state) => state.threadNotifications);
  const inApp = useUi((state) => state.inAppNotifications);
  const confirmUnpin = useUi((state) => state.confirmUnpin);
  const confirmArchive = useUi((state) => state.confirmArchive);
  const confirmDelete = useUi((state) => state.confirmDelete);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("General")}
      <SettingGroup title="Notifications">
        <SettingRow
          title="Thread notifications"
          description="System alerts when a thread finishes, fails, or needs input or approval."
        >
          <select
            aria-label="Thread notifications"
            value={notifications ? "on" : "off"}
            onChange={(event) => {
              const on = event.target.value === "on";
              if (on && "Notification" in window) void Notification.requestPermission();
              setPrefs({ threadNotifications: on });
            }}
          >
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </SettingRow>
        <Toggle
          title="In-app notifications"
          description="Show a toast when another thread finishes, fails, or needs input or approval."
          on={inApp}
          set={(on) => setPrefs({ inAppNotifications: on })}
        />
      </SettingGroup>
      <SettingGroup title="Sidebar">
        <SettingRow title="Project order">
          <select
            aria-label="Project order"
            value={projectSort}
            onChange={(event) => setPrefs({ projectSort: event.target.value as typeof projectSort })}
          >
            <option value="updated_at">Last user message</option>
            <option value="created_at">Created</option>
          </select>
        </SettingRow>
        <SettingRow title="Thread order">
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
                title: "Activity profile",
                options: [
                  { value: "balanced", label: "Balanced" },
                  { value: "saver", label: "Saver" },
                  { value: "performance", label: "Performance" },
                ],
              },
              { key: "automatic_git_fetch_minutes", title: "Git fetch interval (minutes)" },
              { key: "provider_health_refresh_minutes", title: "Provider health interval (minutes)" },
            ],
          },
          {
            title: "Providers",
            rows: [
              { key: "enable_provider_update_checks", title: "Check providers for updates" },
              { key: "prefer_saved_login", title: "Prefer saved login" },
            ],
          },
          {
            title: "New projects",
            rows: [{ key: "add_project_base_directory", title: "Base directory" }],
          },
        ]}
      />
      <SettingGroup title="Confirmations">
        <Toggle title="Unpin confirmation" on={confirmUnpin} set={(on) => setPrefs({ confirmUnpin: on })} />
        <Toggle title="Archive confirmation" on={confirmArchive} set={(on) => setPrefs({ confirmArchive: on })} />
        <Toggle title="Delete confirmation" on={confirmDelete} set={(on) => setPrefs({ confirmDelete: on })} />
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
  const skillsInSlash = useUi((state) => state.skillsInSlashMenu);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Chat")}
      <SettingGroup title="Display">
        <SettingRow title="Chat width">
          <select aria-label="Chat width" value={chatWidth} onChange={(event) => setPrefs({ chatWidth: event.target.value as "comfortable" | "wide" | "full" })}>
            <option value="comfortable">Comfortable</option>
            <option value="wide">Wide</option>
            <option value="full">Full</option>
          </select>
        </SettingRow>
        <SettingRow title="Timestamp format">
          <select aria-label="Timestamp format" value={timestampFormat} onChange={(event) => setPrefs({ timestampFormat: event.target.value as "locale" | "12-hour" | "24-hour" })}>
            <option value="locale">System default</option>
            <option value="12-hour">12-hour</option>
            <option value="24-hour">24-hour</option>
          </select>
        </SettingRow>
        <Toggle title="Word wrap" on={wordWrap} set={(on) => setPrefs({ wordWrap: on })} />
        <Toggle title="Math rendering" on={math} set={(on) => setPrefs({ mathRendering: on })} />
        <Toggle title="Open Changes after large turns" on={proactive} set={(on) => setPrefs({ proactivePanels: on })} />
      </SettingGroup>
      <SettingGroup title="Browser">
        <SettingRow title="Search engine">
          <select aria-label="Search engine" value={searchEngine} onChange={(event) => setPrefs({ previewSearchEngine: event.target.value })}>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="brave">Brave</option>
            <option value="kagi">Kagi</option>
            <option value="startpage">Startpage</option>
          </select>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Composer">
        <Toggle title="Keep checkout and branch visible" on={persistent} set={(on) => setPrefs({ persistentComposerContext: on })} />
        <Toggle title="Show skills in the slash menu" on={skillsInSlash} set={(on) => setPrefs({ skillsInSlashMenu: on })} />
        <SettingRow title="Send shortcut">
          <select aria-label="Send shortcut" value={sendShortcut} onChange={(event) => setPrefs({ sendShortcut: event.target.value as "enter" | "mod-enter-multiline" | "mod-enter" })}>
            <option value="enter">Enter</option>
            <option value="mod-enter-multiline">Mod+Enter when multiline</option>
            <option value="mod-enter">Mod+Enter</option>
          </select>
        </SettingRow>
        <SettingRow title="Follow-up behavior">
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
                title: "Default permissions",
                options: [
                  { value: "supervised", label: "Supervised" },
                  { value: "auto_edits", label: "Auto-accept edits" },
                  { value: "auto", label: "Auto" },
                  { value: "full_access", label: "Full access" },
                ],
              },
              {
                key: "response_streaming_mode",
                title: "Response streaming",
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
              { key: "compact_idle_threads", title: "Compact idle threads" },
              {
                key: "idle_compaction",
                title: "Idle compaction",
                options: [
                  { value: "on_return", label: "On return" },
                  { value: "before_cache_expiry", label: "Before cache expiry" },
                  { value: "never", label: "Never" },
                ],
              },
              { key: "snooze_limited_threads", title: "Snooze threads that hit a limit" },
              { key: "auto_resume_limited_threads", title: "Resume at reset" },
            ],
          },
        ]}
      />
    </>
  );
}

export function DiffsSection() {
  return (
    <>
      {heading("Diffs & pull requests")}
      <PreferenceGroups
        groups={[
          {
            title: "Pull requests",
            rows: [
              {
                key: "pull_request_merge_method",
                title: "Merge method",
                options: [
                  { value: "", label: "Ask" },
                  { value: "merge", label: "Merge" },
                  { value: "squash", label: "Squash" },
                  { value: "rebase", label: "Rebase" },
                ],
              },
              { key: "remove_agent_credits_on_merge", title: "Remove agent credits on merge" },
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
                title: "Default checkout",
                options: [
                  { value: "local", label: "Current checkout" },
                  { value: "worktree", label: "New worktree" },
                ],
              },
              { key: "new_worktrees_start_from_origin", title: "Start from origin" },
              {
                key: "worktree_submodules",
                title: "Submodules",
                options: [
                  { value: "recursive", label: "Recursive" },
                  { value: "top_level", label: "Top level" },
                  { value: "skip", label: "Skip" },
                ],
              },
            ],
          },
          {
            title: "Branch names",
            rows: [
              {
                key: "branch_naming_mode",
                title: "Naming",
                options: [
                  { value: "static", label: "Static" },
                  { value: "semantic", label: "Semantic" },
                  { value: "custom", label: "Custom" },
                ],
              },
              { key: "branch_name_prefix", title: "Branch prefix" },
            ],
          },
        ]}
      />
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
          <SettingRow title="Check again" description="Finds a command line tool or sign-in that has changed.">
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
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Labs")}
      <SettingGroup title="Sidebar">
        <Toggle
          title="Project folders"
          description="Group active threads by project."
          on={folders}
          set={(on) => setPrefs({ projectFolders: on })}
        />
        <Toggle
          title="Multiline rows"
          description="Let thread titles in folders wrap."
          on={multiline}
          set={(on) => setPrefs({ multilineRows: on })}
        />
      </SettingGroup>
    </>
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
