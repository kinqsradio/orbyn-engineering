import type { ServerInfo } from "../generated/ServerInfo";
import type { WireThreadEvent } from "../api/types";

const UPGRADE_KEY = "orbyn.database-upgrade";

const MODE_LABELS: Record<string, string> = {
  supervised: "Supervised",
  auto_edits: "Auto-accept edits",
  auto: "Auto",
  full_access: "Full access",
};

/** The toast for a service start that upgraded the database, once per upgrade. */
export function upgradeToast(info: Pick<ServerInfo, "database_upgrade">): string | null {
  const upgrade = info.database_upgrade;
  if (!upgrade) return null;
  const key = `${upgrade.from}-${upgrade.to}`;
  try {
    if (window.localStorage.getItem(UPGRADE_KEY) === key) return null;
    window.localStorage.setItem(UPGRADE_KEY, key);
  } catch {
    // Without storage the toast may repeat on reload, which is harmless.
  }
  return `Orbyn updated its database (version ${upgrade.from} to ${upgrade.to}). Your threads and settings were kept.`;
}

/** Toasts for a permission change made while a run was live, from fresh events only. */
export function permissionToasts(events: readonly WireThreadEvent[]): string[] {
  return events.flatMap((wire) => {
    const event = wire.event;
    if (event.type !== "CUSTOM" || event.name !== "permission.updated") return [];
    const value = (event.value ?? {}) as { mode?: string; applies?: string };
    if (value.applies !== "next_run") return [];
    const label = MODE_LABELS[value.mode ?? ""] ?? "a new mode";
    return [`Permission mode is now ${label}. The running turn keeps its mode; the next turn uses the new one.`];
  });
}
