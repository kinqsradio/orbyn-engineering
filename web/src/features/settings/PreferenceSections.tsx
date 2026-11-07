import { ChevronDown, Search } from "lucide-react";
import { settingsLabel } from "./settingsSearch";
import { useEffect, useState } from "react";
import { api, request } from "../../api/client";
import type { ForgeStatus, Thread } from "../../api/types";
import type { ProjectGroupingMode } from "../../generated/ProjectGroupingMode";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects } from "../../state/workspace";
import { Button, Pill } from "../../ui/controls";
import licenses from "./licenses.json";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { Segmented } from "../../ui/Segmented";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { unarchiveThread } from "../workspace/threadActions";
import { Menu } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";
import { DETAIL_ROWS, detailsMenuItems } from "../thread/DetailsCard";
import { DesktopApp } from "./DesktopApp";
import { Advanced, PreferenceGroups } from "./PreferenceRows";
import { WorktreeCleanup } from "./WorktreeCleanup";
import { SourceControlWriting } from "./SourceControlWriting";
import type { TriagePlaybook } from "../../generated/TriagePlaybook";
import { navigate } from "../../state/route";
import { DRAFT_KEY, SCRATCH } from "../../state/draftStore";

const heading = (title: string) => (
  <h1 className="sr-only" tabIndex={-1} data-page-title>
    {title}
  </h1>
);

export function Toggle({ title, description, on, set }: { title: string; description?: string; on: boolean; set(on: boolean): void }) {
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
        icon={<ChevronDown size={13} aria-hidden />}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        {DETAIL_ROWS.length - hidden.length} of {DETAIL_ROWS.length} on
      </Button>
      <Presence>{anchor ? <Menu {...anchor} label="Thread details rows" items={detailsMenuItems()} onClose={() => setAnchor(null)} /> : null}</Presence>
    </>
  );
}

/** A whole number with its unit beside it, saved when the field loses focus. */
function NumberWithUnit({ value, unit, label, save, disabled }: { value: unknown; unit: string; label: string; save(next: number): void; disabled: boolean }) {
  return (
    <span className="unit-field">
      <input type="number" min={1} aria-label={label} disabled={disabled} defaultValue={typeof value === "number" ? value : ""}
        onBlur={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next) && event.target.value !== "" && next !== value) save(next);
        }} />
      <span className="t3">{unit}</span>
    </span>
  );
}

const unitRow = (key: string, title: string, description: string, unit = "minutes") => ({
  key, title, description,
  render: (value: unknown, save: (next: unknown) => void, control: { disabled: boolean }) => <NumberWithUnit value={value} unit={unit} label={title} save={save} disabled={control.disabled} />,
});

export function GeneralSection() {
  const working = useUi((state) => state.workingSection);
  const projectGrouping = useUi((state) => state.projectGrouping);
  const threadSort = useUi((state) => state.threadSort);
  const projectSort = useUi((state) => state.projectSort);
  const notifications = useUi((state) => state.threadNotifications);
  const inApp = useUi((state) => state.inAppNotifications);
  const confirmUnpin = useUi((state) => state.confirmUnpin);
  const confirmArchive = useUi((state) => state.confirmArchive);
  const confirmDelete = useUi((state) => state.confirmDelete);
  const setPrefs = useUi((state) => state.setPrefs);
  const sound = useUi((state) => state.threadSound);
  const order = [{ value: "updated_at", label: "Last user message" }, { value: "created_at", label: "Created" }] as const;
  return (
    <>
      {heading("General")}
      <PreferenceGroups groups={[{ title: "", rows: [{
        key: "default_thread_env_mode",
        title: settingsLabel("general-new-threads-start-in"),
        options: [
          { value: "local", label: "Current checkout" },
          { value: "worktree", label: "A new worktree" },
        ],
      }] }]} />
      <SettingGroup>
        <SettingRow title={settingsLabel("general-thread-notifications")} description="When a thread finishes, fails or needs you">
          <Segmented
            label="Thread notifications"
            value={notifications ? (sound ? "both" : "alert") : sound ? "sound" : "off"}
            options={[
              { value: "off", label: "Off" },
              { value: "alert", label: "Notifications" },
              { value: "sound", label: "Sound" },
              { value: "both", label: "Both" },
            ]}
            onChange={(value) => {
              const alert = value === "alert" || value === "both";
              if (alert && "Notification" in window) void Notification.requestPermission();
              setPrefs({ threadNotifications: alert, threadSound: value === "sound" || value === "both" });
            }}
          />
        </SettingRow>
        <Toggle
          title={settingsLabel("general-in-app-notifications")}
          description="A toast when another thread finishes, fails or needs input"
          on={inApp}
          set={(on) => setPrefs({ inAppNotifications: on })}
        />
      </SettingGroup>
      <PreferenceGroups groups={[{ title: "", rows: [{
        key: "quit_confirmation",
        title: settingsLabel("general-quit-confirmation"),
        description: "How ⌘Q quits the desktop app on macOS. The Quit menu item always quits.",
        segmented: true,
        options: [
          { value: "direct", label: "Quit at once" },
          { value: "hold", label: "Hold ⌘Q" },
          { value: "double_press", label: "Press ⌘Q twice" },
        ],
      }] }]} />
      <SettingGroup>
        <SettingRow title={settingsLabel("general-project-grouping")} description="How projects in the same repository are shown">
          <Segmented
            label="Project grouping"
            value={projectGrouping}
            options={[
              { value: "repository", label: "Repository" },
              { value: "repository_path", label: "Repository path" },
              { value: "separate", label: "Separate" },
            ]}
            onChange={(value) => setPrefs({ projectGrouping: value as ProjectGroupingMode })}
          />
        </SettingRow>
        <SettingRow title={settingsLabel("general-project-order")}>
          <Segmented label="Project order" value={projectSort} options={[...order]} onChange={(value) => setPrefs({ projectSort: value })} />
        </SettingRow>
        <SettingRow title={settingsLabel("general-thread-order")}>
          <Segmented label="Thread order" value={threadSort} options={[...order]} onChange={(value) => setPrefs({ threadSort: value })} />
        </SettingRow>
        <Toggle
          title={settingsLabel("general-working-section")}
          description="Fold working threads into a shelf at the top of the sidebar"
          on={working}
          set={(on) => setPrefs({ workingSection: on })}
        />
        <SettingRow title={settingsLabel("general-rows")} description="Choose what the details card shows. You can also right-click the card.">
          <DetailRowsButton />
        </SettingRow>
      </SettingGroup>
      <PreferenceGroups groups={[{ title: "", rows: [{
        key: "background_activity_profile",
        title: settingsLabel("general-activity-profile"),
        description: "How often the app refreshes in the background",
        segmented: true,
        options: [
          { value: "balanced", label: "Balanced" },
          { value: "saver", label: "Saver" },
          { value: "performance", label: "Performance" },
        ],
      },
      unitRow("automatic_git_fetch_minutes", settingsLabel("general-git-fetch-interval-minutes"), "Background git fetch period"),
      unitRow("provider_health_refresh_minutes", settingsLabel("general-provider-health-interval-minutes"), "How often providers are checked"),
      { key: "enable_provider_update_checks", title: settingsLabel("general-check-providers-for-updates") },
      { key: "keep_awake_during_runs", title: settingsLabel("general-keep-the-computer-awake-during-runs"), description: "Desktop only. The display can still sleep." },
      { key: "add_project_base_directory", title: settingsLabel("general-base-directory"), description: "Where new projects are created" },
      ] }]} />
      <DesktopApp />
      <p className="set-grp">Ask before</p>
      <SettingGroup>
        <Toggle title={settingsLabel("general-unpin-confirmation")} on={confirmUnpin} set={(on) => setPrefs({ confirmUnpin: on })} />
        <Toggle title={settingsLabel("general-archive-confirmation")} on={confirmArchive} set={(on) => setPrefs({ confirmArchive: on })} />
        <Toggle title={settingsLabel("general-delete-confirmation")} on={confirmDelete} set={(on) => setPrefs({ confirmDelete: on })} />
      </SettingGroup>
    </>
  );
}

const MOD = typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

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
      <SettingGroup>
        <SettingRow title={settingsLabel("chat-chat-width")}>
          <Segmented
            label="Chat width"
            value={chatWidth}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "wide", label: "Wide" },
              { value: "full", label: "Full" },
            ]}
            onChange={(next) => setPrefs({ chatWidth: next })}
          />
        </SettingRow>
        <SettingRow title={settingsLabel("chat-send-shortcut")} description="What sends a message">
          <select aria-label="Send shortcut" value={sendShortcut} onChange={(event) => setPrefs({ sendShortcut: event.target.value as "enter" | "mod-enter-multiline" | "mod-enter" })}>
            <option value="enter">Enter</option>
            <option value="mod-enter-multiline">{MOD} Enter when the message has several lines</option>
            <option value="mod-enter">{MOD} Enter</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("chat-while-a-turn-runs-enter")}>
          <Segmented
            label="While a turn runs, Enter"
            value={followUpBehavior}
            options={[
              { value: "queue", label: "Queues" },
              { value: "steer", label: "Steers" },
            ]}
            onChange={(next) => setPrefs({ followUpBehavior: next })}
          />
        </SettingRow>
        <Toggle title={settingsLabel("chat-math-rendering")} on={math} set={(on) => setPrefs({ mathRendering: on })} />
      </SettingGroup>
      <PreferenceGroups groups={[{ title: "", rows: [
        { key: "response_streaming_mode", title: settingsLabel("chat-show-answers"),
          options: [
            { value: "paragraph", label: "By paragraph" },
            { value: "turn", label: "When the turn ends" },
          ] },
        { key: "default_permission_mode", title: settingsLabel("chat-default-access-mode"),
          options: [
            { value: "supervised", label: "Supervised" },
            { value: "auto_edits", label: "Auto-accept edits" },
            { value: "auto", label: "Auto" },
            { value: "full_access", label: "Full access" },
          ] },
      ] }]} />
      <SettingGroup>
        <SettingRow title={settingsLabel("chat-timestamp-format")}>
          <Segmented
            label="Timestamp format"
            value={timestampFormat}
            options={[
              { value: "locale", label: "System default" },
              { value: "12-hour", label: "12-hour" },
              { value: "24-hour", label: "24-hour" },
            ]}
            onChange={(next) => setPrefs({ timestampFormat: next })}
          />
        </SettingRow>
        <Toggle title={settingsLabel("chat-word-wrap")} description="Wrap long lines in code" on={wordWrap} set={(on) => setPrefs({ wordWrap: on })} />
        <Toggle title={settingsLabel("chat-keep-checkout-and-branch-visible")} description="In the composer’s context line" on={persistent} set={(on) => setPrefs({ persistentComposerContext: on })} />
        <Toggle title={settingsLabel("chat-show-skills-in-the-slash-menu")} on={skillsInSlash} set={(on) => setPrefs({ skillsInSlashMenu: on })} />
        <Toggle title={settingsLabel("chat-float-pages-agents-open")} description="Float a page over the chat instead of replacing the panel" on={autoFloat} set={(on) => setPrefs({ autoFloatPreview: on })} />
        <Toggle title={settingsLabel("chat-open-changes-after-large-turns")} description="Opens the Changes panel by itself" on={proactive} set={(on) => setPrefs({ proactivePanels: on })} />
      </SettingGroup>
      <SettingGroup>
        <SettingRow title={settingsLabel("chat-search-engine")} description="For the Browser panel’s address bar">
          <select aria-label="Search engine" value={searchEngine} onChange={(event) => setPrefs({ previewSearchEngine: event.target.value })}>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="brave">Brave</option>
            <option value="kagi">Kagi</option>
            <option value="startpage">Startpage</option>
          </select>
        </SettingRow>
        <SettingRow title={settingsLabel("chat-open-links-in")}>
          <Segmented
            label="Open links in"
            value={linkTarget}
            options={[
              { value: "system", label: "System browser" },
              { value: "in-app", label: "Browser panel" },
            ]}
            onChange={(next) => setPrefs({ linkTarget: next })}
          />
        </SettingRow>
      </SettingGroup>
      <PreferenceGroups
        groups={[
          {
            title: "",
            rows: [
              { key: "open_web_links_in_app", title: settingsLabel("chat-open-links-from-other-apps"), description: "macOS links open in the Browser panel" },
            ],
          },
        ]}
      />
      <p className="set-grp">Idle threads and limits</p>
      <PreferenceGroups
        groups={[
          {
            title: "",
            rows: [
              { key: "compact_idle_threads", title: settingsLabel("chat-compact-idle-threads") },
              {
                key: "idle_compaction",
                title: settingsLabel("chat-idle-compaction"),
                description: "When an idle thread is compacted",
                segmented: true,
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

/** The same stored layout the diff panel's own switch uses. */
function DiffViewRow() {
  const layout = useUi((state) => state.diffLayout);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <SettingRow title={settingsLabel("diffs-diff-view")}>
      <Segmented
        label="Diff view"
        value={layout}
        options={[
          { value: "stacked", label: "Unified" },
          { value: "split", label: "Split" },
        ]}
        onChange={(next) => setPrefs({ diffLayout: next })}
      />
    </SettingRow>
  );
}

export function DiffsSection() {
  const inApp = useUi((state) => state.pullLinksInApp);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Diffs & pull requests")}
      <SettingGroup>
        <DiffViewRow />
      </SettingGroup>
      <PreferenceGroups groups={[{ title: "", rows: [{
        key: "pull_request_merge_method",
        title: settingsLabel("diffs-merge-method"),
        options: [
          { value: "", label: "Ask" },
          { value: "merge", label: "Merge" },
          { value: "squash", label: "Squash" },
          { value: "rebase", label: "Rebase" },
        ],
      }] }]} />
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
              { key: "remove_agent_credits_on_merge", title: settingsLabel("diffs-remove-agent-credits-on-merge") },
            ],
          },
          {
            title: "Review guides",
            rows: [
              {
                key: "review_guides_enabled",
                title: settingsLabel("diffs-review-guides"),
                description: "An agent writes a stop-by-stop guide for a pull request. The guide stays in Orbyn.",
              },
              {
                key: "review_guide_instructions",
                title: settingsLabel("diffs-guide-instructions"),
                description: "Added to the request that asks the agent for a guide.",
                multiline: true,
              },
              {
                key: "review_guide_model",
                title: settingsLabel("diffs-guide-model"),
                description: "A model ID for the guide thread. Empty uses the engine's default.",
              },
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
              { key: "new_worktrees_start_from_origin", title: settingsLabel("worktrees-start-from-origin") },
              {
                key: "worktree_submodules",
                title: settingsLabel("worktrees-submodules"),
                options: [
                  { value: "recursive", label: "Recursive" },
                  { value: "top-level", label: "Top level only" },
                  { value: "none", label: "Skip" },
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
      <WorktreeCleanup />
    </>
  );
}

export function SourceControlSection() {
  const forges = useAsync("forges", (signal) => request<ForgeStatus[]>("GET", "/api/forges", undefined, signal));
  return (
    <>
      {heading("Source control")}
      <SourceControlWriting />
      <PreferenceGroups groups={[{ title: "Repositories", rows: [{
        key: "auto_pull", title: settingsLabel("source-control-automatic-pull"),
        description: "Keeps the default branch current when the checkout has no local changes or commits.",
      }] }]} />
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
  const multiline = useUi((state) => state.multilineRows);
  const plan = useUi((state) => state.planControls);
  const meter = useUi((state) => state.contextMeter);
  const setPrefs = useUi((state) => state.setPrefs);
  return (
    <>
      {heading("Labs")}
      <SettingGroup title="Sidebar">
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
  const [open, setOpen] = useState(false);
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
    <>
      <SettingGroup>
        <SettingRow title="Open-source licences">
          <Button small aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "View"}</Button>
        </SettingRow>
      </SettingGroup>
      {open ? <>{group("Open source in the interface", licenses.scripts)}{group("Open source in the service", licenses.crates)}</> : null}
    </>
  );
}

/** Whether the service looks for an app update on its own. Nothing is applied without a click. */
function AutomaticUpdateChecks() {
  const settings = useAsync("server-settings", (signal) => api.settings(signal));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Toggle
        title={settingsLabel("about-check-for-updates-automatically")}
        on={settings.data?.background_update_checks !== false}
        set={(on) => {
          if (!settings.data) return;
          void api.putSettings({ ...settings.data, background_update_checks: on }).then(settings.setData, (failure: unknown) => setError(toFailure(failure).message));
        }}
      />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </>
  );
}

/** Opens a draft holding the service's triage playbook; the person picks an agent and sends it. */
function TriageRow() {
  const pushToast = useUi((state) => state.pushToast);
  const start = async () => {
    try {
      const playbook = await request<TriagePlaybook>("GET", "/api/triage/playbook");
      useUi.getState().setDraft(DRAFT_KEY, playbook.prompt);
      navigate({ name: "new", projectId: SCRATCH });
    } catch (failure) {
      pushToast(`Couldn't start triage: ${toFailure(failure).message}`);
    }
  };
  return (
    <SettingRow title={settingsLabel("about-triage")} description="Starts a thread with a support playbook for this version. Nothing is sent until you send it.">
      <Button small onClick={() => void start()}>
        Start triage
      </Button>
    </SettingRow>
  );
}

/** The service reports Rust's OS id, such as `macos`. */
const PLATFORM_NAMES: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
export const platformName = (id: string) => PLATFORM_NAMES[id] ?? id;

export function AboutSection() {
  const info = useAsync("about-info", (signal) => api.info(signal));
  return (
    <>
      {heading("About")}
      <div className="set-card">
        <span className="set-logo" aria-hidden>O</span>
        <div><b>Orbyn Engineering {info.data?.version ?? ""}</b></div>
      </div>
      <SettingGroup>
        <AutomaticUpdateChecks />
      </SettingGroup>
      <OpenSourceLicenses />
      <SettingGroup title="Orbyn Engineering">
        <SettingRow title="Platform">{info.data ? platformName(info.data.platform) : "Unknown"}</SettingRow>
        <TriageRow />
      </SettingGroup>
    </>
  );
}

export function ArchiveSection() {
  const projects = useVisibleProjects();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const columns = { gridTemplateColumns: "minmax(0, 1fr) 160px 110px 150px" };
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
        <>
          <label className="set-find">
            <Search size={13} aria-hidden />
            <input aria-label="Find an archived thread" placeholder="Find an archived thread" value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <div className="set-tbl" role="table" aria-label="Archived threads">
            <div className="set-tr h" role="row" style={columns}>
              <span role="columnheader">Thread</span><span role="columnheader">Project</span><span role="columnheader">Archived</span><span role="columnheader" />
            </div>
            {threads.filter((thread) => thread.title.toLowerCase().includes(filter.trim().toLowerCase())).map((thread) => (
              <div key={thread.id} role="row" className="set-tr" style={columns}>
                <span role="cell">{thread.title}</span>
                <span role="cell" className="t3">{projects?.find((p) => p.id === thread.project_id)?.name ?? ""}</span>
                <span role="cell" className="t3">{new Date(thread.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                <span role="cell" className="row-actions">
                  <Button
                    small
                    onClick={() => {
                      void unarchiveThread(thread);
                      setThreads(threads.filter((entry) => entry.id !== thread.id));
                    }}
                  >
                    Restore
                  </Button>
                  <Button small tone="danger" onClick={() => void remove(thread)}>
                    Delete
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
