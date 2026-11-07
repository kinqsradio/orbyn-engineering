import { Check, ChevronDown, ChevronLeft, CloudOff, RefreshCw, Search } from "lucide-react";
import { settingsLabel } from "./settingsSearch";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "../../state/connection";
import { api, request } from "../../api/client";
import type { ForgeStatus, Thread } from "../../api/types";
import type { ProjectGroupingMode } from "../../generated/ProjectGroupingMode";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { useVisibleProjects, useWorkspace } from "../../state/workspace";
import { Button } from "../../ui/controls";
import licenses from "./licenses.json";
import { Empty, ErrorState, Loading } from "../../ui/states";
import { Segmented } from "../../ui/Segmented";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { unarchiveThread } from "../workspace/threadActions";
import { ConfirmDialog } from "../../ui/Dialog";
import { BaseDirectoryDialog } from "./BaseDirectoryDialog";
import { Menu } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";
import { DETAIL_ROWS, detailsMenuItems } from "../thread/DetailsCard";
import { DesktopApp } from "./DesktopApp";
import { PreferenceGroups } from "./PreferenceRows";
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

/** A text field with the folder browser beside it. */
function BaseDirectory({ value, save, disabled }: { value: unknown; save(next: unknown): void; disabled: boolean }) {
  const [choosing, setChoosing] = useState(false);
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  return (
    <>
      <input aria-label="Base directory" value={draft} disabled={disabled} spellCheck={false}
        onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== (value ?? "")) save(draft); }} />
      <Button small disabled={disabled} onClick={() => setChoosing(true)}>Choose…</Button>
      {choosing ? (
        <BaseDirectoryDialog onClose={() => setChoosing(false)} onChoose={(path) => { setDraft(path); save(path); setChoosing(false); }} />
      ) : null}
    </>
  );
}

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
      { key: "add_project_base_directory", title: settingsLabel("general-base-directory"), description: "Where new projects are created",
        render: (value, save, control) => <BaseDirectory value={value} save={save} disabled={control.disabled} /> },
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
        <SettingRow title={settingsLabel("chat-while-a-turn-runs-enter")} description="Steer sends it into the turn that is running.">
          <select aria-label="While a turn runs, Enter" value={followUpBehavior} onChange={(event) => setPrefs({ followUpBehavior: event.target.value as "queue" | "steer" })}>
            <option value="queue">Queues the message</option>
            <option value="steer">Steers the running turn</option>
          </select>
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
      <SettingGroup>
        <SettingRow title={settingsLabel("diffs-open-pull-request-links-here")} description="In the Pull requests page, or on the host">
          <Segmented
            label="Open pull request links here"
            value={inApp ? "app" : "host"}
            options={[
              { value: "app", label: "In the app" },
              { value: "host", label: "On the host" },
            ]}
            onChange={(next) => setPrefs({ pullLinksInApp: next === "app" })}
          />
        </SettingRow>
      </SettingGroup>
      <PreferenceGroups
        groups={[
          {
            title: "",
            rows: [
              { key: "remove_agent_credits_on_merge", title: settingsLabel("diffs-remove-agent-credits-on-merge"), description: "Strips agent credit lines from the merged commit message" },
              {
                key: "review_guides_enabled",
                title: settingsLabel("diffs-review-guides"),
                description: "An agent writes a walkthrough for each pull request",
              },
              {
                key: "review_guide_instructions",
                title: settingsLabel("diffs-guide-instructions"),
                description: "What the guide should cover",
                multiline: true,
              },
              { key: "review_guide_model", title: settingsLabel("diffs-guide-model") },
            ],
          },
        ]}
      />
    </>
  );
}

const NAMING_MODES = [
  { value: "static", label: "Static", description: "The prefix plus a fixed name." },
  { value: "semantic", label: "From the thread", description: "Named from the thread automatically." },
  { value: "custom", label: "Custom", description: "Named using your branch name instructions." },
];

/** The three ways a branch is named, each saying what it does. */
function BranchNaming({ value, save }: { value: string; save(next: string): void }) {
  const chosen = NAMING_MODES.find((mode) => mode.value === value);
  return <div className="set-naming">
    <Segmented label="Branch naming" value={value} options={NAMING_MODES.map(({ value, label }) => ({ value, label }))} onChange={save} />
    {chosen ? <small className="set-naming-note">{chosen.description}</small> : null}
  </div>;
}

/** The prefix without its slash, and the branch name it makes. */
function BranchPrefix({ value, save, disabled, mixed }: { value: string; save(next: string): void; disabled: boolean; mixed?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const clean = draft.trim().replace(/\/+$/, "");
  return <div className="set-naming">
    <input aria-label="Branch prefix" className="mono" spellCheck={false} disabled={disabled} value={draft} placeholder={mixed ? "Mixed" : undefined}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (clean !== value) save(clean); }}
      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
    <small className="set-naming-note mono">{clean ? `${clean}/fix-login` : "fix-login"}</small>
  </div>;
}

export function WorktreesSection() {
  return (
    <>
      {heading("Worktrees")}
      <SettingGroup>
        <SettingRow title="Worktree folder" description="Next to each project"><span className="mono set-muted">&lt;project&gt;-wt/&lt;purpose&gt;</span></SettingRow>
      </SettingGroup>
      <PreferenceGroups
        groups={[
          {
            title: "",
            rows: [
              { key: "new_worktrees_start_from_origin", title: settingsLabel("worktrees-start-from-origin"), description: "Base new worktrees on the remote branch, not the local one" },
              {
                key: "worktree_submodules",
                title: settingsLabel("worktrees-submodules"),
                description: "Initialise submodules in each new worktree",
                options: [
                  { value: "recursive", label: "Recursive" },
                  { value: "top-level", label: "Top level only" },
                  { value: "none", label: "Skip" },
                ],
              },
              {
                key: "branch_naming_mode",
                title: settingsLabel("worktrees-naming"),
                render: (value, save) => <BranchNaming value={String(value ?? "")} save={save} />,
              },
              {
                key: "branch_name_prefix",
                title: settingsLabel("worktrees-branch-prefix"),
                description: "A / is added after the prefix.",
                render: (value, save, control) => <BranchPrefix value={String(value ?? "")} save={save} disabled={control.disabled} mixed={control.mixed} />,
              },
              { key: "branch_name_instructions", title: settingsLabel("worktrees-branch-name-instructions"), description: "Extra guidance for the names Orbyn generates", multiline: true,
                showWhen: (valueOf) => valueOf("branch_naming_mode") === "custom" },
            ],
          },
        ]}
      />
      <WorktreeCleanup />
    </>
  );
}

export function SourceControlSection() {
  const forges = useAsync("forges", (signal) => request<ForgeStatus[]>("GET", "/api/forges", undefined, signal));
  const offline = useConnection((state) => state.offline);
  const scannedAt = useRef<number | null>(null);
  if (forges.status === "ready" && !offline) scannedAt.current = Date.now();
  return (
    <>
      {heading("Source control")}
      <SourceControlWriting />
      <PreferenceGroups groups={[{ title: "", rows: [{
        key: "auto_pull", title: settingsLabel("source-control-automatic-pull"),
        description: "Keep tracked branches up to date in the background",
      }] }]} />
      <div className="set-hosts-head">
        <b>Hosts</b>
        <Button small disabled={offline} icon={<RefreshCw size={13} aria-hidden />} onClick={forges.reload}>Rescan</Button>
      </div>
      {offline ? <p className="banner" role="status"><CloudOff size={14} aria-hidden />You’re offline. Showing the last scan{scannedAt.current ? ` from ${new Date(scannedAt.current).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : ""}. Rescan and sign-in are unavailable.</p> : null}
      {forges.status === "loading" ? (
        <><span className="sr-only" role="status">Rescanning your remotes…</span><Loading label="Checking source control" rows={3} /></>
      ) : forges.status === "error" ? (
        <ErrorState title="Couldn't check source control" failure={forges.error} onRetry={forges.reload} />
      ) : forges.data.length === 0 ? (
        <Empty title="No Git hosts found"><p>Add a project with a remote and they appear here.</p>
          <Button small disabled={offline} icon={<RefreshCw size={13} aria-hidden />} onClick={forges.reload}>Rescan</Button></Empty>
      ) : (
        <div className="set-tbl" role="table" aria-label="Hosts">
          {forges.data.map((forge) => (
            <div key={forge.id} role="row" className="set-tr" style={{ gridTemplateColumns: "28px minmax(0, 1fr) 150px" }}>
              <span role="cell"><span className="set-mark">{forge.name.charAt(0).toUpperCase()}</span></span>
              <span role="cell"><span className="name">{forge.name}</span>{forge.problem ?? forge.accounts.join(", ") ? <><br /><span className="sub">{forge.problem ?? forge.accounts.join(", ")}</span></> : null}</span>
              <span role="cell">
                {forge.problem && !forge.signed_in ? <span className="set-pill warn">Can’t reach {forge.name}</span>
                  : forge.signed_in ? <span className="set-pill"><Check size={13} aria-hidden />Signed in</span>
                  : <span className="set-pill">{forge.installed ? "Not signed in" : "Not installed"}</span>}
              </span>
            </div>
          ))}
        </div>
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

/** The two lists of open-source packages, one for the interface and one for the service. */
function LicenceLists({ onBack }: { onBack(): void }) {
  const [list, setList] = useState<"scripts" | "crates">("scripts");
  const [filter, setFilter] = useState("");
  const rows = licenses[list].filter((entry) => entry.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <>
      <div className="set-back">
        <Button small tone="quiet" icon={<ChevronLeft size={13} aria-hidden />} onClick={onBack}>About</Button>
        <h2 className="set-back-title">Open-source licences</h2>
      </div>
      <div className="set-licence-bar">
        <Segmented<"scripts" | "crates"> label="Licence list" value={list} onChange={setList}
          options={[{ value: "scripts", label: `App · ${licenses.scripts.length}` }, { value: "crates", label: `Service · ${licenses.crates.length}` }]} />
        <label className="set-find">
          <Search size={13} aria-hidden />
          <input aria-label="Find a package" placeholder="Find a package" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
      </div>
      <div className="set-tbl" role="table" aria-label="Packages">
        <div className="set-tr h" role="row" style={{ gridTemplateColumns: "minmax(0, 1fr) 110px 110px" }}>
          <span role="columnheader">Package</span><span role="columnheader">Version</span><span role="columnheader">Licence</span>
        </div>
        {rows.map((entry) => (
          <div key={entry.name} role="row" className="set-tr" style={{ gridTemplateColumns: "minmax(0, 1fr) 110px 110px" }}>
            <span role="cell">{entry.name}</span><span role="cell" className="t3">{entry.version}</span><span role="cell" className="t3">{entry.license}</span>
          </div>
        ))}
      </div>
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
        description="Same setting as Background checks in Maintenance"
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

/** The agent CLIs Orbyn found and their versions, with a re-check. */
function AgentClis() {
  const engines = useWorkspace((state) => state.engines.data);
  const refresh = useWorkspace((state) => state.refreshEngines);
  const [checking, setChecking] = useState(false);
  const found = (engines ?? []).filter((engine) => !engine.instance_of && engine.installed && engine.version);
  if (found.length === 0) return null;
  return (
    <SettingRow title="Agent CLIs" description={found.map((engine) => `${engine.name} ${engine.version}`).join(" · ")}>
      <Button small busy={checking} onClick={() => { setChecking(true); void api.refreshEngines().then(refresh).finally(() => setChecking(false)); }}>Check</Button>
    </SettingRow>
  );
}

/** The service reports Rust's OS id, such as `macos`. */
const PLATFORM_NAMES: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
export const platformName = (id: string) => PLATFORM_NAMES[id] ?? id;

export function AboutSection() {
  const info = useAsync("about-info", (signal) => api.info(signal));
  const [licences, setLicences] = useState(false);
  if (licences) return <><h1 className="sr-only" tabIndex={-1} data-page-title>About</h1><LicenceLists onBack={() => setLicences(false)} /></>;
  return (
    <>
      {heading("About")}
      <div className="set-card">
        <span className="set-logo" aria-hidden>O</span>
        <div>
          <b>Orbyn Engineering {info.data?.version ?? ""}</b>
          <br /><span className="t3 sub">Platform {info.data ? platformName(info.data.platform) : "Unknown"}</span>
        </div>
      </div>
      <SettingGroup>
        <AutomaticUpdateChecks />
        <AgentClis />
        <TriageRow />
        <SettingRow title="Open-source licences" description="The app and the service">
          <Button small onClick={() => setLicences(true)}>View lists</Button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}

/** The project's name over its archived threads. A project that was removed keeps its group, with a neutral Removed tag. */
export function ArchiveGroupHead({ name, removed }: { name: string; removed: boolean }) {
  return <p className="set-grp set-grp-tight">{name}{removed ? <span className="set-pill">Removed</span> : null}</p>;
}

export function ArchiveSection() {
  const projects = useVisibleProjects();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Thread | null>(null);
  const columns = { gridTemplateColumns: "minmax(0, 1fr) 110px 190px" };
  useEffect(() => {
    const abort = new AbortController();
    api.archivedThreads(abort.signal).then(
      (list) => setThreads(list.sort((a, b) => b.updated_at.localeCompare(a.updated_at))),
      (failure: unknown) => {
        if (!abort.signal.aborted) setError(toFailure(failure).message);
      },
    );
    return () => abort.abort();
  }, []);
  const remove = async (thread: Thread) => {
    setThreads((threads ?? []).filter((entry) => entry.id !== thread.id));
    await api.deleteThread(thread.id).catch((failure: unknown) => setError(toFailure(failure).message));
  };
  // The sidebar's order first, then the projects that were removed, each under the name it had.
  const groups = threads === null || !projects ? [] : [
    ...projects.map((project) => ({ key: project.id, name: project.name, removed: false, owned: threads.filter((thread) => !thread.project_removed && thread.project_id === project.id) })),
    ...[...new Set(threads.filter((thread) => thread.project_removed).map((thread) => thread.project_id))].map((id) => {
      const owned = threads.filter((thread) => thread.project_removed && thread.project_id === id);
      return { key: id, name: owned[0]?.removed_project_name ?? id, removed: true, owned };
    }),
  ].filter((group) => group.owned.length > 0);
  return (
    <>
      {heading("Archive")}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {!threads || !projects ? (
        <Loading label="Loading archived threads" rows={3} />
      ) : groups.length === 0 ? (
        <Empty title="No archived threads" />
      ) : (
        <>
          {groups.map((group) => (
              <section key={group.key} aria-label={group.name}>
                <ArchiveGroupHead name={group.name} removed={group.removed} />
                <div className="set-tbl" role="table" aria-label={`Archived threads in ${group.name}`}>
                  {group.owned.map((thread) => (
                    <div key={thread.id} role="row" className="set-tr" style={columns}>
                      <span role="cell">{thread.title}</span>
                      <span role="cell" className="t3">{new Date(thread.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                      <span role="cell" className="row-actions">
                        {group.removed ? (
                          <span title="Add the project back to unarchive">
                            <Button small disabled>Unarchive</Button>
                          </span>
                        ) : (
                          <Button
                            small
                            onClick={() => {
                              void unarchiveThread(thread);
                              setThreads(threads.filter((entry) => entry.id !== thread.id));
                            }}
                          >
                            Unarchive
                          </Button>
                        )}
                        <Button small tone="danger" onClick={() => setDeleting(thread)}>
                          Delete
                        </Button>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
          ))}
          {deleting ? (
            <ConfirmDialog title={`Delete “${deleting.title}”?`} confirmLabel="Delete thread" tone="danger" cancelFocus
              onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)}>
              <p>The thread and its messages are removed from this computer. This can’t be undone.</p>
            </ConfirmDialog>
          ) : null}
        </>
      )}
    </>
  );
}
