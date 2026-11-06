import type { EngineStatus } from "../../api/types";
import { PreferenceGroups } from "./PreferenceRows";
import { useSettingsScope } from "./SettingsScopeContext";

/**
 * Which providers new threads may use, per project. The list holds the ones turned
 * off; the service refuses a thread on one of them in that project.
 */
export function ProjectProviders({ engines }: { engines: EngineStatus[] }) {
  const scope = useSettingsScope();
  const project = scope?.query.selection !== undefined;
  return <>
    <PreferenceGroups groups={[{ title: "Providers in use", rows: [{
      key: "disabled_engines", title: "Providers in use", inheritance: true,
      description: project ? "Turn a provider off for this project. Its threads stay; new ones can't use it."
        : "Turn a provider off for every project that doesn't choose for itself.",
      render: (value, save, control) => {
        const off = Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
        return <ul className="provider-toggles">
          {engines.map((engine) => <li key={engine.id}>
            <label>
              <input type="checkbox" role="switch" disabled={control.disabled}
                aria-checked={control.mixed ? "mixed" : !off.includes(engine.id)}
                ref={(element) => { if (element) element.indeterminate = control.mixed; }}
                checked={!control.mixed && !off.includes(engine.id)}
                onChange={(event) => {
                  const base = control.mixed ? [] : off;
                  save(event.target.checked ? base.filter((id) => id !== engine.id) : [...new Set([...base, engine.id])]);
                }} />
              {engine.name}
            </label>
          </li>)}
        </ul>;
      },
    }] }]} />
    {project ? <p className="muted">Provider instances and custom models are saved for this environment and apply to every project.</p> : null}
  </>;
}
