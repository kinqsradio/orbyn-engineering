import { settingsLabel } from "./settingsSearch";
import { useState } from "react";
import { api } from "../../api/client";
import type { ServerSettings } from "../../api/types";
import type { SnoozePreset } from "../../generated/SnoozePreset";
import { toFailure, useAsync } from "../../lib/useAsync";
import { Button } from "../../ui/controls";
import { ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";
import { useUi } from "../../state/ui";
import { PreferenceGroups } from "./PreferenceRows";
import { Toggle } from "./PreferenceSections";
import { HistoryImport } from "./HistoryImport";
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
const lengthText = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;

/** The choices a thread's Snooze menu offers, in this order. */
function SnoozePresets({ presets, save }: { presets: SnoozePreset[]; save(next: SnoozePreset[]): void }) {
  const [label, setLabel] = useState("");
  const [minutes, setMinutes] = useState("");
  const valid = label.trim() !== "" && Number(minutes) > 0 && Number(minutes) <= MAX_MINUTES;
  return (
    <>
      <p className="set-grp">Snooze presets</p>
      <SettingGroup>
        {presets.map((preset) => (
          <SettingRow key={preset.label} title={preset.label}>
            <span className="t3">{lengthText(preset.minutes)}</span>
            <Button small tone="quiet" aria-label={`Remove ${preset.label}`} onClick={() => save(presets.filter((entry) => entry !== preset))}>
              Remove
            </Button>
          </SettingRow>
        ))}
      </SettingGroup>
      <div className="set-add" aria-label={settingsLabel("threads-add-a-preset")} id="threads-add-a-preset" tabIndex={-1}>
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
      </div>
    </>
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
      <SettingGroup>
        <Toggle
          title={settingsLabel("threads-group-by-project")}
          description="In the sidebar"
          on={folders}
          set={(on) => setPrefs({ projectFolders: on })}
        />
      </SettingGroup>
      <PreferenceGroups groups={[{ title: "", rows: [
        { key: "auto_thread_titles", title: settingsLabel("threads-name-new-threads"), description: "From the first message" },
      ] }]} />
      <HistoryImport inSettings />
      <PreferenceGroups groups={[{ title: "", rows: [
        { key: "auto_settle_after_days", title: settingsLabel("threads-settle-idle-threads"),
          description: "Move a thread out of the way after it has been idle",
          options: AFTER_DAYS.map((entry) => ({ value: entry.value === null ? "" : String(entry.value), label: entry.label })),
          parse: (value) => value === "" ? null : Number(value) },
        { key: "auto_settle_on_merge", title: settingsLabel("threads-settle-on-merge"),
          description: "When its pull request merges" },
        { key: "auto_settle_keep_pull_requests", title: settingsLabel("threads-keep-pull-requests"),
          description: "Never settle a thread whose pull request is still open" },
        { key: "enable_agent_browser_access", title: settingsLabel("threads-agent-browser-access"),
          description: "Agents can open pages and click in the Browser panel" },
        { key: "continue_threads_after_update", title: settingsLabel("threads-continue-after-update"),
          description: "Resume threads the update interrupted" },
        { key: "project_title_instructions", title: settingsLabel("threads-title-instructions"),
          description: "How a thread’s name is written", multiline: true },
        { key: "text_generation_model", title: settingsLabel("threads-title-model") },
      ] }]} />
      <fieldset className="preference-control" disabled={Boolean(projectScoped)}>
        <SnoozePresets presets={data.snooze_presets} save={(snooze_presets) => save({ ...data, snooze_presets })} />
      </fieldset>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
