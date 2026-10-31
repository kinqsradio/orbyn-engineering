import { useSyncExternalStore } from "react";

export const SETTINGS_SECTIONS = [
  "engines",
  "skills",
  "policy",
  "audit",
  "computer",
  "access",
  "appearance",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { name: "home" }
  | { name: "approvals" }
  | { name: "thread"; id: string }
  | { name: "new"; projectId: string | null }
  | { name: "add-project" }
  | { name: "trust"; projectId: string; threadId: string | null }
  | { name: "settings"; section: SettingsSection | null };

const enc = encodeURIComponent;

export function routeHref(route: Route): string {
  switch (route.name) {
    case "home":
      return "#/";
    case "approvals":
      return "#/approvals";
    case "thread":
      return `#/threads/${enc(route.id)}`;
    case "new":
      return route.projectId ? `#/new/${enc(route.projectId)}` : "#/new";
    case "add-project":
      return "#/add-project";
    case "trust":
      return `#/trust/${enc(route.projectId)}${route.threadId ? `/${enc(route.threadId)}` : ""}`;
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
    case "approvals":
      return { name: "approvals" };
    case "threads":
      return first ? { name: "thread", id: first } : { name: "home" };
    case "new":
      return { name: "new", projectId: first ?? null };
    case "add-project":
      return { name: "add-project" };
    case "trust":
      return first ? { name: "trust", projectId: first, threadId: second ?? null } : { name: "home" };
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
