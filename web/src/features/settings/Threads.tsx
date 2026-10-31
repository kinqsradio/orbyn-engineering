import { useState } from "react";
import { api } from "../../api/client";
import type { ServerSettings } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const AFTER_DAYS: { value: number | null; label: string }[] = [
  { value: null, label: "Never" },
  { value: 1, label: "After 1 day" },
  { value: 3, label: "After 3 days" },
  { value: 7, label: "After 7 days" },
  { value: 30, label: "After 30 days" },
];

export function ThreadsSection() {
  const settings = useAsync("server-settings", (signal) => api.settings(signal));
  const [error, setError] = useState<string | null>(null);
  const [titles, setTitles] = useState<string | null>(null);

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
      <SettingGroup title="Auto-settle">
        <SettingRow title="Settle idle threads" description="Move finished threads into Settled after a quiet period.">
          <select
            aria-label="Settle idle threads"
            value={data.auto_settle.after_days ?? ""}
            onChange={(event) =>
              save({
                ...data,
                auto_settle: {
                  ...data.auto_settle,
                  after_days: event.target.value === "" ? null : Number(event.target.value),
                },
              })
            }
          >
            {AFTER_DAYS.map((option) => (
              <option key={option.label} value={option.value ?? ""}>
                {option.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title="Settle on merge" description="Settle a thread when its pull request merges.">
          <input
            type="checkbox"
            aria-label="Settle on merge"
            checked={data.auto_settle.on_merge}
            onChange={(event) =>
              save({ ...data, auto_settle: { ...data.auto_settle, on_merge: event.target.checked } })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Titles">
        <SettingRow title="Title instructions" description="Guidance used when a thread title is generated.">
          <textarea
            aria-label="Title instructions"
            rows={2}
            value={titles ?? data.title_instructions ?? ""}
            onChange={(event) => setTitles(event.target.value)}
            onBlur={() => {
              if (titles !== null) save({ ...data, title_instructions: titles.trim() || null });
            }}
          />
        </SettingRow>
      </SettingGroup>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
