import { api } from "../../api/client";
import type { ReleaseChannel } from "../../generated/ReleaseChannel";
import { useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Pill } from "../../ui/controls";

const CHANNEL_LABEL: Record<ReleaseChannel, string> = { stable: "Stable", nightly: "Nightly", dev: "Dev" };

/** Marks the local environment's build next to the brand, as the viewer chose. */
export function EnvironmentIdentity() {
  const mode = useUi((state) => state.environmentIdentification);
  const info = useAsync("environment-identity", (signal) => api.info(signal));
  const channel = info.data?.channel ?? "stable";
  if (mode === "none" || !info.data) return null;
  if (mode === "pill") {
    const label = channel === "stable" ? `v${info.data.version}` : `v${info.data.version} ${CHANNEL_LABEL[channel]}`;
    return <span className="environment-identity"><Pill title={`${info.data.environment_label}, ${CHANNEL_LABEL[channel]} build`}>{label}</Pill></span>;
  }
  if (channel === "stable") return null;
  return (
    <span className="environment-identity environment-art" data-channel={channel} title={`${CHANNEL_LABEL[channel]} build`}>
      {CHANNEL_LABEL[channel]}
    </span>
  );
}
