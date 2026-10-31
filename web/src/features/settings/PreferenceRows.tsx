import { useState } from "react";
import { request } from "../../api/client";
import type { PreferenceView } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { ErrorState, Loading } from "../../ui/states";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

export interface PreferenceRow {
  key: string;
  title: string;
  description?: string;
  /** Value and label, for a fixed choice. */
  options?: { value: string; label: string }[];
  /** For a value none of the plain controls fit. */
  render?(value: unknown, save: (next: unknown) => void): React.ReactNode;
}

const q = encodeURIComponent;

/** Rows backed by the service's preferences. A failed save keeps the saved value. */
export function PreferenceGroups({
  groups,
  projectId,
}: {
  groups: { title: string; rows: PreferenceRow[] }[];
  /** Reads and writes what this project sets over the global value. */
  projectId?: string;
}) {
  const send = (values: Record<string, unknown>) =>
    request<PreferenceView[]>("PUT", projectId ? `/api/projects/${q(projectId)}/preferences` : "/api/preferences", { values });
  const list = useAsync(`preferences:${projectId ?? ""}`, (signal) =>
    request<PreferenceView[]>("GET", `/api/preferences${projectId ? `?project_id=${q(projectId)}` : ""}`, undefined, signal),
  );
  const [error, setError] = useState<string | null>(null);
  if (list.status === "loading") return <Loading label="Loading settings" rows={3} />;
  if (list.status === "error") {
    return <ErrorState title="Couldn't load settings" failure={list.error} onRetry={list.reload} />;
  }
  const save = (key: string, value: unknown) => {
    setError(null);
    send({ [key]: value }).then(list.setData, (failure: unknown) => setError(toFailure(failure).message));
  };
  return (
    <>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {groups.map((group) => (
        <SettingGroup key={group.title} title={group.title}>
          {group.rows.map((row) => {
            const view = list.data.find((entry) => entry.key === row.key);
            if (!view) return null;
            const value = view.value;
            return (
              <SettingRow key={row.key} title={row.title} description={row.description}>
                {row.render ? (
                  row.render(value, (next) => save(row.key, next))
                ) : row.options ? (
                  <select
                    aria-label={row.title}
                    value={String(value ?? "")}
                    onChange={(event) => save(row.key, event.target.value)}
                  >
                    {row.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : typeof view.default === "boolean" ? (
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={row.title}
                    checked={value === true}
                    onChange={(event) => save(row.key, event.target.checked)}
                  />
                ) : (
                  <input
                    aria-label={row.title}
                    type={typeof view.default === "number" ? "number" : "text"}
                    key={String(value ?? "")}
                    defaultValue={String(value ?? "")}
                    onBlur={(event) =>
                      save(row.key, typeof view.default === "number" ? Number(event.target.value) : event.target.value)
                    }
                  />
                )}
              </SettingRow>
            );
          })}
        </SettingGroup>
      ))}
    </>
  );
}
