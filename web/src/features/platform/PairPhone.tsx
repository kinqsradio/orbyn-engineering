import { Smartphone } from "lucide-react";
import { Button } from "../../ui/controls";
import { SettingsFrame } from "./SettingsFrame";
import { unavailable } from "./Unavailable";
import type { PairingOffer } from "./types";

const SIDE = 11;

/** Pair a phone: scan the code, then confirm that both screens show the same six digits. */
export function PairPhone({ offer }: { offer: PairingOffer }) {
  return (
    <SettingsFrame active="Remote access" title="Remote access">
      <section className="platform-card platform-pair" aria-labelledby="platform-pair-title">
        <div
          className="platform-qr"
          role="img"
          aria-label="Sample pairing code, not scannable"
          style={{ gridTemplateColumns: `repeat(${SIDE}, 1fr)` }}
        >
          {[...offer.cells].map((cell, index) => (
            <i key={index} data-on={cell === "1" ? "true" : undefined} />
          ))}
        </div>
        <div className="platform-pair-text">
          <h3 id="platform-pair-title">Pair a phone</h3>
          <p className="platform-lede">Open Orbyn on your phone and scan this code.</p>
          <p className="platform-hint">Then check that both screens show</p>
          <output className="platform-digits" aria-label={`Pairing digits ${offer.code}`}>
            {offer.code}
          </output>
          <div className="platform-actions">
            <Button {...unavailable}>Cancel</Button>
            <Button tone="primary" {...unavailable}>
              They match
            </Button>
          </div>
        </div>
      </section>
      <h3 className="platform-subtitle">Paired devices</h3>
      <ul className="platform-devices">
        {offer.devices.map((device) => (
          <li key={device.name}>
            <Smartphone size={16} aria-hidden />
            <span>{device.name}</span>
            <span className="platform-hint">{device.lastSeen}</span>
            <Button tone="quiet" small {...unavailable}>
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </SettingsFrame>
  );
}
