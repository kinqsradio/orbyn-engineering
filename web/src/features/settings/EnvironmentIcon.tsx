import { Laptop, Monitor, PcCase, Server, type LucideIcon } from "lucide-react";

const ICONS: Record<string, LucideIcon> = { laptop: Laptop, desktop: Monitor, tower: PcCase, server: Server };

/** The local environment's machine kind, or the plain monitor when none is chosen. */
export function EnvironmentIcon({ icon, size = 14 }: { icon: string | null | undefined; size?: number }) {
  const Icon = (icon && ICONS[icon]) || Monitor;
  return <Icon size={size} aria-hidden data-environment-icon={icon || "default"} />;
}

export const ENVIRONMENT_ICON_CHOICES = [
  { value: "", label: "Default" },
  { value: "laptop", label: "Laptop" },
  { value: "desktop", label: "Desktop" },
  { value: "tower", label: "Tower" },
  { value: "server", label: "Server" },
];
