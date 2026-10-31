import { useSyncExternalStore } from "react";

export const SETTINGS_SECTIONS = [
  "appearance",
  "keybindings",
  "providers",
  "threads",
  "projects",
  "maintenance",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { name: "home" }
  | { name: "thread"; id: string }
  | { name: "new"; projectId: string | null }
  | { name: "trust"; projectId: string; threadId: string | null }
  | { name: "settings"; section: SettingsSection | null }
  | { name: "usage" }
  | { name: "pulls" };

const enc = encodeURIComponent;

export function routeHref(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "thread":
      return `#/threads/${enc(route.id)}`;
    case "new":
      return route.projectId ? `#/new/${enc(route.projectId)}` : "#/new";
    case "trust":
      return `#/trust/${enc(route.projectId)}${route.threadId ? `/${enc(route.threadId)}` : ""}`;
    case "usage":
      return "#/usage";
    case "pulls":
      return "#/pulls";
    case "settings":
      return route.section ? `#/settings/${route.section}` : "#/settings";
  }
}

export function parseRoute(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  const [head, first, second] = parts;
  switch (head) {
    case "threads":
      return first ? { name: "thread", id: first } : { name: "home" };
    case "new":
      return { name: "new", projectId: first ?? null };
    case "trust":
      return first ? { name: "trust", projectId: first, threadId: second ?? null } : { name: "home" };
    case "usage":
      return { name: "usage" };
    case "pulls":
      return { name: "pulls" };
    case "settings":
      return {
        name: "settings",
        section: SETTINGS_SECTIONS.find((section) => section === first) ?? null,
      };
    default:
      return { name: "home" };
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHref(route).slice(1);
}

const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
