import { Button } from "../../ui/controls";
import { SettingsFrame } from "./SettingsFrame";
import { unavailable } from "./Unavailable";
import type { CapabilityRow, ConnectConsent } from "./types";

const stateText: Record<CapabilityRow["state"], string> = {
  allow: "Allow",
  never: "Never",
  separate: "Asked separately",
};

/** The connected-app consent: list-scoped access for a limited device that can never delete. */
export function ConnectPlanner({ consent }: { consent: ConnectConsent }) {
  return (
    <SettingsFrame active="Labs" title={`Connect ${consent.app}`}>
      <section className="platform-card" aria-labelledby="platform-connect-title">
        <h3 id="platform-connect-title">Connect {consent.app}</h3>
        <p className="platform-lede">
          Orbyn Engineering asks to work with your planner. It joins as a limited device and sees only the lists you
          pick.
        </p>
        <dl className="platform-rows">
          {consent.capabilities.map((row) => (
            <div key={row.grant} className="platform-row" data-grant={row.grant}>
              <dt>{row.label}</dt>
              <dd data-state={row.state}>{stateText[row.state]}</dd>
            </div>
          ))}
        </dl>
        <fieldset className="platform-lists">
          <legend>Lists it can use</legend>
          {consent.lists.map((list) => (
            <label key={list.name} className="platform-chip">
              <input type="checkbox" defaultChecked={list.granted} {...unavailable} />
              {list.name}
            </label>
          ))}
        </fieldset>
        <div className="platform-actions">
          <Button {...unavailable}>Cancel</Button>
          <Button tone="primary" {...unavailable}>
            Connect
          </Button>
        </div>
        <p className="platform-hint">
          You can see its activity or disconnect it in Planner, Settings, Connected apps. Disconnecting removes
          Engineering from those lists; the tasks it added stay.
        </p>
      </section>
    </SettingsFrame>
  );
}
