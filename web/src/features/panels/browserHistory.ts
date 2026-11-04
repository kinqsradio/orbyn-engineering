import { create } from "zustand";
import { serviceUrl } from "../../api/origin";
import { readToken } from "../../api/token";
import { readJson, writeJson } from "../../lib/storage";

const KEY = "orbyn.browser-icons.v1";
const LIMIT = 50;

/** Mirrors the proxy's URL envelope; DNS, bytes and formats remain service-owned. */
export function iconUrl(raw: unknown): string | null {
  const page = pageUrl(raw);
  if (!page) return null;
  const url = new URL(page);
  return url.protocol === "https:" && !url.port ? url.href : null;
}

/** A visited page can be a local development server; its icon still uses the proxy. */
function pageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export interface SiteIcon { page: string; icon: string }

export function readIcons(value: unknown): SiteIcon[] {
  if (!Array.isArray(value)) return [];
  const result: SiteIcon[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const page = pageUrl(entry.page);
    const icon = iconUrl(entry.icon);
    if (page && icon && !result.some((item) => item.page === page)) result.push({ page, icon });
    if (result.length === LIMIT) break;
  }
  return result;
}

export const useBrowserHistory = create<{ icons: SiteIcon[]; remember(page: string, icon: string): void }>((set) => ({
  icons: readIcons(readJson<unknown>(KEY)),
  remember(rawPage, rawIcon) {
    const page = pageUrl(rawPage);
    const icon = iconUrl(rawIcon);
    if (!page || !icon) return;
    set((state) => {
      if (state.icons[0]?.page === page && state.icons[0].icon === icon) return state;
      const icons = [{ page, icon }, ...state.icons.filter((item) => item.page !== page)].slice(0, LIMIT);
      writeJson(KEY, icons);
      return { icons };
    });
  },
}));

/** Tokens belong to this launch, never to persisted history. */
export function proxyIconUrl(icon: string): string {
  const query = new URLSearchParams({ url: icon });
  const token = readToken();
  if (token) query.set("token", token);
  return serviceUrl(`/api/media/image?${query}`);
}
