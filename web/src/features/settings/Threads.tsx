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
import { PreferenceGroups } from "./PreferenceRows";
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
      <PreferenceGroups groups={[{ title: "Auto-settle", rows: [
        { key: "auto_settle_after_days", title: settingsLabel("threads-settle-idle-threads"),
          description: "Move finished threads into Settled after a quiet period.",
          options: AFTER_DAYS.map((entry) => ({ value: entry.value === null ? "" : String(entry.value), label: entry.label })),
          parse: (value) => value === "" ? null : Number(value) },
        { key: "auto_settle_on_merge", title: settingsLabel("threads-settle-on-merge"),
          description: "Settle a thread when its pull request merges." },
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
