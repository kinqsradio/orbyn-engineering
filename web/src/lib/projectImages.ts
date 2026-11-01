import { request } from "../api/client";
import { serviceUrl } from "../api/origin";
import type { Project } from "../api/types";
import type { ProjectIconImage } from "../generated/ProjectIconImage";
import type { ProjectIconMediaType } from "../generated/ProjectIconMediaType";

type Identity = Pick<Project, "id" | "path">;
interface Entry {
  controller: AbortController;
  url: string | null;
  expires: number;
  pending: boolean;
  deadline?: ReturnType<typeof setTimeout>;
}
const entries = new Map<string, Entry>();
const subscribers = new Map<string, { project: Identity; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> }>();
const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_DEADLINE = 30_000;
const HIT_TTL = 10 * 60_000;
const MISS_TTL = 60_000;
const MIME: Record<ProjectIconMediaType, string> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  heic: "image/heic", heif: "image/heif", tiff: "image/tiff",
};

export function projectImageKey(project: Identity): string {
  const origin = new URL(serviceUrl("/"), window.location.href).origin;
  return JSON.stringify([origin, project.id, project.path]);
}
function notify(key: string) {
  subscribers.get(key)?.listeners.forEach((listener) => listener());
}
function remove(key: string) {
  const entry = entries.get(key);
  clearTimeout(entry?.deadline);
  entry?.controller.abort();
  entries.delete(key);
  notify(key);
}
function bound() {
  let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.url?.length ?? 0), 0);
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    bytes -= entry.url?.length ?? 0;
    remove(key);
  }
}
function imageUrl(value: ProjectIconImage, project: Identity): string | null {
  if (!value || typeof value !== "object" || value.project_id !== project.id || value.project_path !== project.path || !value.image) return null;
  const { media_type: type, data_base64: data } = value.image;
  if (!Object.hasOwn(MIME, type) || typeof data !== "string" || data.length === 0 ||
      data.length > 1_398_104 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (data.length / 4 * 3 - padding > 1024 * 1024) return null;
  return `data:${MIME[type]};base64,${data}`;
}
function ensure(key: string, project: Identity) {
  const old = entries.get(key);
  if (old && (old.pending || old.expires > Date.now())) return;
  const entry: Entry = { controller: new AbortController(), url: null, expires: 0, pending: true };
  entries.set(key, entry);
  entry.deadline = setTimeout(() => {
    if (entries.get(key) !== entry) return;
    entry.controller.abort();
    // Replace the observation, so even a transport ignoring abort cannot
    // publish its eventual reply after this request has expired.
    entries.set(key, { controller: new AbortController(), url: null, pending: false,
      expires: Date.now() + MISS_TTL });
    notify(key);
  }, REQUEST_DEADLINE);
  bound();
  void request<ProjectIconImage>("GET", `/api/projects/${encodeURIComponent(project.id)}/icon`, undefined, entry.controller.signal)
    .then((value) => {
      if (entries.get(key) !== entry) return;
      entry.url = imageUrl(value, project);
    }, () => {
      // The shared request owns authentication/reconnect reporting. Badges use
      // their automatic identity while this optional local image is unavailable.
    })
    .finally(() => {
      clearTimeout(entry.deadline);
      if (entries.get(key) !== entry) return;
      entry.pending = false;
      entry.expires = Date.now() + (entry.url ? HIT_TTL : MISS_TTL);
      entries.delete(key);
      entries.set(key, entry);
      bound();
      notify(key);
    });
}
export function readProjectImage(key: string): string | null {
  return entries.get(key)?.url ?? null;
}
export function subscribeProjectImage(key: string, project: Identity, listener: () => void): () => void {
  let subscribed = subscribers.get(key);
  if (!subscribed) {
    subscribed = { project: { id: project.id, path: project.path }, listeners: new Set(),
      timer: setInterval(() => ensure(key, project), MISS_TTL) };
    subscribers.set(key, subscribed);
  }
  subscribed.listeners.add(listener);
  ensure(key, subscribed.project);
  return () => {
    subscribed.listeners.delete(listener);
    if (!subscribed.listeners.size) {
      clearInterval(subscribed.timer);
      subscribers.delete(key);
    }
    // Other mounted badges and the bounded cache share this request; a single
    // disappearing subscriber must not cancel another surface's image.
  };
}
export function rejectProjectImage(key: string, url: string) {
  const entry = entries.get(key);
  if (!entry || entry.url !== url) return;
  entry.url = null;
  entry.expires = Date.now() + MISS_TTL;
  notify(key);
}
/** A project refresh/reconnect reobserves local files; bytes never enter persistence. */
export function invalidateProjectImages(projectId?: string) {
  for (const key of [...entries.keys()]) {
    const identity: unknown = JSON.parse(key);
    if (projectId === undefined || (Array.isArray(identity) && identity[1] === projectId)) remove(key);
  }
  for (const [key, subscribed] of subscribers) {
    if (projectId === undefined) ensure(key, subscribed.project);
  }
}
