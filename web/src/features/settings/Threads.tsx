import { settingsLabel } from "./settingsSearch";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { ServerSettings } from "../../api/types";
import type { SnoozePreset } from "../../generated/SnoozePreset";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button, IconButton } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { useUi } from "../../state/ui";
import { PreferenceGroups } from "./PreferenceRows";
import { Toggle } from "./PreferenceSections";
import { useSettingsScope } from "./SettingsScopeContext";

const AFTER_DAYS: { value: number | null; label: string }[] = [
  { value: null, label: "Never" },
  { value: 1, label: "After 1 day" },
  { value: 3, label: "After 3 days" },
  { value: 7, label: "After 7 days" },
  { value: 30, label: "After 30 days" },
];

const MAX_PRESETS = 8;
const MAX_MINUTES = 30 * 24 * 60;

/** The choices a thread's Snooze menu offers, in this order. */
function SnoozePresets({ presets, save }: { presets: SnoozePreset[]; save(next: SnoozePreset[]): void }) {
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState("");
  const valid = label.trim() !== "" && Number(minutes) > 0 && Number(minutes) <= MAX_MINUTES;
  return (
    <SettingGroup title="Snooze presets">
      {presets.map((preset) => (
        <SettingRow key={preset.label} title={preset.label} description={`${preset.minutes} minutes`}>
          <IconButton label={`Remove ${preset.label}`} onClick={() => save(presets.filter((entry) => entry !== preset))}>
            <Trash2 size={14} aria-hidden />
          </IconButton>
        </SettingRow>
      ))}
      <SettingRow title={settingsLabel("threads-add-a-preset")} description={`Up to ${MAX_PRESETS}, each up to 30 days.`}>
        <input aria-label="Preset name" placeholder="Name" value={label} onChange={(event) => setLabel(event.target.value)} />
        <input aria-label="Preset minutes" type="number" min="1" placeholder="Minutes" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        <Button
          small
          disabled={!valid || presets.length >= MAX_PRESETS}
          onClick={() => {
            save([...presets, { label: label.trim(), minutes: Number(minutes) }]);
            setLabel("");
            setMinutes("");
          }}
        >
          Add
        </Button>
      </SettingRow>
    </SettingGroup>
  );
}

export function ThreadsSection() {
  const settings = useAsync("server-settings", (signal) => api.settings(signal));
  const [error, setError] = useState<string | null>(null);
  const scope = useSettingsScope();
  const folders = useUi((state) => state.projectFolders);
  const setPrefs = useUi((state) => state.setPrefs);
  const projectScoped = scope?.active && scope.query.selection && scope.query.selection.kind !== "all_projects";

  const save = (next: ServerSettings) => {
    setError(null);
    api.putSettings(next).then(settings.setData, (failure: unknown) => {
      setError(toFailure(failure).message);
    });
  };

  if (settings.status === "loading") return <Loading label="Loading thread settings" rows={3} />;
  if (settings.status === "error") {
    return <ErrorState title="Couldn't load thread settings" failure={settings.error} onRetry={settings.reload} />;
  }
  const data = settings.data;
  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Threads
      </h1>
      <SettingGroup title="Sidebar">
        <Toggle
          title={settingsLabel("threads-group-by-project")}
          description="List active threads under their project in the sidebar."
          on={folders}
          set={(on) => setPrefs({ projectFolders: on })}
        />
      </SettingGroup>
      <PreferenceGroups groups={[{ title: "Auto-settle", rows: [
        { key: "auto_settle_after_days", title: settingsLabel("threads-settle-idle-threads"),
          description: "Move finished threads into Settled after a quiet period.",
          options: AFTER_DAYS.map((entry) => ({ value: entry.value === null ? "" : String(entry.value), label: entry.label })),
          parse: (value) => value === "" ? null : Number(value) },
        { key: "auto_settle_on_merge", title: settingsLabel("threads-settle-on-merge"),
          description: "Settle a thread when its pull request merges." },
        { key: "auto_settle_keep_pull_requests", title: settingsLabel("threads-keep-pull-requests"),
          description: "Leave a thread whose pull request is still open out of idle settling." },
      ] }, { title: "New threads", rows: [
        { key: "default_permission_mode", title: settingsLabel("threads-default-permissions"),
          options: [
            { value: "supervised", label: "Supervised" },
            { value: "auto_edits", label: "Auto-accept edits" },
            { value: "auto", label: "Auto" },
            { value: "full_access", label: "Full access" },
          ] },
        { key: "response_streaming_mode", title: settingsLabel("threads-response-streaming"), segmented: true,
          options: [
            { value: "paragraph", label: "By paragraph" },
            { value: "turn", label: "When the turn ends" },
          ] },
      ] }, { title: "Agents", rows: [
        { key: "enable_agent_browser_access", title: settingsLabel("threads-agent-browser-access"),
          description: "Lets agents open and drive pages in the Browser panel. Off refuses their browser tools." },
        { key: "continue_threads_after_update", title: settingsLabel("threads-continue-after-update"),
          description: "After Orbyn restarts, pick up the threads the restart interrupted." },
      ] }, { title: "Titles", rows: [
        { key: "project_title_instructions", title: settingsLabel("threads-title-instructions"),
          description: "Guidance used when a thread title is generated.", multiline: true },
      ] }]} />
      <fieldset className="preference-control" disabled={Boolean(projectScoped)}>
        <SnoozePresets presets={data.snooze_presets} save={(snooze_presets) => save({ ...data, snooze_presets })} />
      </fieldset>
      <PreferenceGroups
        groups={[
          {
            title: "Title generation",
            rows: [
              {
                key: "auto_thread_titles",
                title: settingsLabel("threads-name-new-threads"),
                description: "Title a thread from its first message. Each title spends a little engine usage.",
              },
              {
                key: "text_generation_model",
                title: settingsLabel("threads-title-model"),
                description: "A model ID. Empty uses the engine's small model.",
              },
            ],
          },
        ]}
      />
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
