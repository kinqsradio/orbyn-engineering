import { useSyncExternalStore } from "react";
import type { ProjectSettingsSelection } from "../generated/ProjectSettingsSelection";

export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "chat",
  "diffs",
  "keybindings",
  "providers",
  "threads",
  "tasks",
  "projects",
  "source-control",
  "worktrees",
  "maintenance",
  "labs",
  "about",
  "archive",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type Route =
  | { name: "home" }
  | { name: "thread"; id: string }
  | { name: "new"; projectId: string | null }
  | { name: "trust"; projectId: string; threadId: string | null }
  | {
      name: "settings";
      section: SettingsSection | null;
      selection?: ProjectSettingsSelection;
      machine?: string;
      task?: string;
      /** With `task`: open the editor instead of the task page. */
      edit?: boolean;
    }
  | { name: "usage" }
  | { name: "tasks" }
  /** The list, or one pull request of one project. */
  | { name: "pulls"; project?: string; number?: number };

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
    case "tasks":
      return "#/tasks";
    case "pulls":
      return route.project !== undefined && route.number !== undefined ? `#/pulls/${enc(route.project)}/${route.number}` : "#/pulls";
    case "settings": {
      const path = route.section ? `#/settings/${route.section}` : "#/settings";
      const params = new URLSearchParams();
      if (route.machine !== undefined) params.set("machine", route.machine);
      if (route.selection?.kind === "project_group" || route.selection?.kind === "checkout") params.set("project", route.selection.group_key);
      if (route.selection?.kind === "checkout") params.set("checkout", route.selection.project_id);
      if (route.task !== undefined) params.set("task", route.task);
      if (route.task !== undefined && route.edit) params.set("edit", "1");
      return params.size ? `${path}?${params}` : path;
    }
  }
}

export function parseRoute(hash: string): Route {
  const separator = hash.indexOf("?");
  const path = separator < 0 ? hash : hash.slice(0, separator);
  const search = separator < 0 ? "" : hash.slice(separator + 1);
  const params = new URLSearchParams(search);
  const parts = path
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
    case "tasks":
      return { name: "tasks" };
    case "pulls": {
      const number = Number(second);
      return first && Number.isInteger(number) && number > 0 ? { name: "pulls", project: first, number } : { name: "pulls" };
    }
    case "settings": {
      // Presence matters: stale and empty IDs remain explicit instead of widening scope.
      const selection: ProjectSettingsSelection | undefined = params.has("checkout")
        ? { kind: "checkout", group_key: params.get("project") ?? "", project_id: params.get("checkout") ?? "" }
        : params.has("project") ? { kind: "project_group", group_key: params.get("project") ?? "" } : undefined;
      return {
        name: "settings",
        section: SETTINGS_SECTIONS.find((section) => section === first) ?? null,
        ...(selection ? { selection } : {}),
        ...(params.has("machine") ? { machine: params.get("machine") ?? "" } : {}),
        ...(params.has("task") ? { task: params.get("task") ?? "", ...(params.get("edit") === "1" ? { edit: true } : {}) } : {}),
      };
    }
    default:
      return { name: "home" };
  }
}

export function navigate(route: Route): void {
  const current = parseRoute(window.location.hash);
  const next = route.name === "settings" && !("selection" in route) && current.name === "settings"
    ? { ...route, selection: current.selection, machine: current.machine } : route;
  goToHash(routeHref(next).slice(1));
}

/**
 * Moves to a hash route. While a modal sheet holds its history entry (`history.state.sheet`), the
 * navigation replaces that entry instead of pushing one, and the sheet closes with it: the stack
 * [list, list + sheet] becomes [list, destination]. Typed addresses and links out can't be seen.
 */
export function goToHash(hash: string): void {
  if ((window.history.state as { sheet?: boolean } | null)?.sheet === true) {
    window.history.replaceState(null, "", `#${hash}`);
    // replaceState says nothing, so tell the router and the sheet.
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = hash;
}

const subscribe = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
