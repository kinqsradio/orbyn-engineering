import { request } from "../api/client";
import { serviceUrl } from "../api/origin";
import { readToken } from "../api/token";
import type { Project } from "../api/types";
import type { ProjectIconResource } from "../generated/ProjectIconResource";
import type { ProjectIconResourceData } from "../generated/ProjectIconResourceData";
import { MissingProjectImage, PROJECT_IMAGE_MIME, projectImagePreview } from "./projectImagePreview";
import { clearStoredProjectImages, deleteStoredProjectImage, purgeStoredProjectImages,
  readStoredProjectImage, storeProjectImage, type StoredProjectImage } from "./projectImagePersistence";

/** Fixed image-purpose routes, never a caller-supplied asset URL. */
export function projectImageCandidateUrl(projectId: string, path: string): string {
  const query = new URLSearchParams({ path });
  const token = readToken();
  if (token) query.set("token", token);
  return serviceUrl(`/api/projects/${encodeURIComponent(projectId)}/images/raw?${query}`);
}
export function projectIconRawUrl(projectId: string, authenticated = true, revision?: string): string {
  const query = new URLSearchParams();
  if (revision) query.set("v", revision);
  const token = authenticated ? readToken() : null;
  if (token) query.set("token", token);
  return serviceUrl(`/api/projects/${encodeURIComponent(projectId)}/icon/raw${query.size ? `?${query}` : ""}`);
}

type Identity = Pick<Project, "id" | "path"> & Partial<Pick<Project, "favicon_path">>;
type Outcome = "pending" | "hit" | "missing" | "error";
interface Entry {
  project: Identity;
  persistentKey: string;
  controller: AbortController;
  url: string | null;
  cached: StoredProjectImage | null;
  expires: number;
  pending: boolean;
  final: boolean;
  outcome: Outcome;
  resourceRevision?: string;
  deadline?: ReturnType<typeof setTimeout>;
}
const entries = new Map<string, Entry>();
const subscribers = new Map<string, { project: Identity; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> }>();
const MAX_ENTRIES = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_DEADLINE = 30_000;
const HIT_TTL = 10 * 60_000;
const MISS_TTL = 60_000;

export function projectImageKey(project: Identity): string {
  const origin = new URL(serviceUrl("/"), window.location.href).origin;
  return JSON.stringify([origin, project.id, project.path, project.favicon_path ?? null]);
}
export function projectImagePersistentKey(project: Identity): string {
  // The native asset origin survives owned service-port changes. A physical ID
  // and registered root keep restored previews scoped to their project.
  const origin = window.location.protocol === "tauri:" && window.location.hostname === "localhost"
    ? "tauri://localhost" : window.location.origin;
  return JSON.stringify([origin, project.id, project.path, project.favicon_path ?? null]);
}
function notify(key: string) { subscribers.get(key)?.listeners.forEach((listener) => listener()); }
function remove(key: string) {
  const entry = entries.get(key);
  clearTimeout(entry?.deadline); entry?.controller.abort();
  entries.delete(key); notify(key);
}
function bound() {
  let bytes = [...entries.values()].reduce((sum, entry) => sum + (entry.url?.length ?? 0), 0);
  for (const [key, entry] of entries) {
    if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    bytes -= entry.url?.length ?? 0; remove(key);
  }
}
function resourceImage(value: ProjectIconResource, project: Identity): ProjectIconResourceData | null {
  if (!value || typeof value !== "object" || value.project_id !== project.id || value.project_path !== project.path
    || !Object.hasOwn(value, "favicon_path") || value.favicon_path !== (project.favicon_path ?? null)) {
    throw new Error("Project image identity changed.");
  }
  if (value.image === null) return null;
  const image = value.image;
  if (!image || typeof image !== "object" || !Object.hasOwn(PROJECT_IMAGE_MIME, image.media_type)
    || !["saved_image", "project_file", "automatic"].includes(image.source)
    || typeof image.relative_path !== "string" || !image.relative_path.length || image.relative_path.length > 8192
    || typeof image.revision !== "string" || !/^[a-f0-9]{64}$/.test(image.revision)
    || !Number.isSafeInteger(image.size) || image.size < 0 || image.size > 1024 * 1024 * 1024) {
    throw new Error("Project image resource is invalid.");
  }
  return image;
}
function ensure(key: string, project: Identity) {
  const old = entries.get(key);
  if (old && (old.pending || old.expires > Date.now())) return;
  const entry: Entry = {
    project: { ...project }, persistentKey: projectImagePersistentKey(project), controller: new AbortController(),
    url: old?.url ?? null, cached: old?.cached ?? null, expires: 0, pending: true, final: false, outcome: "pending",
  };
  entries.set(key, entry);
  const current = () => entries.get(key) === entry && !entry.controller.signal.aborted;
  entry.deadline = setTimeout(() => {
    if (entries.get(key) !== entry) return;
    entry.controller.abort();
    entries.set(key, { ...entry, controller: new AbortController(), pending: false, final: true,
      outcome: "error", deadline: undefined, expires: Date.now() + MISS_TTL });
    notify(key);
  }, REQUEST_DEADLINE);
  bound();
  void readStoredProjectImage(entry.persistentKey, project.id).then((cached) => {
    if (!cached || !current() || entry.final || entry.outcome === "missing") return;
    entry.cached = cached; entry.url = cached.data_url; bound(); notify(key);
  });
  void request<ProjectIconResource>("GET", `/api/projects/${encodeURIComponent(project.id)}/icon/resource`, undefined, entry.controller.signal)
    .then(async (value) => {
      if (!current()) return;
      const image = resourceImage(value, project);
      if (!image) {
        entry.outcome = "missing"; entry.final = true; entry.url = null; entry.cached = null;
        void deleteStoredProjectImage(entry.persistentKey, project.id);
        return;
      }
      entry.outcome = "hit"; entry.resourceRevision = image.revision;
      if (entry.cached?.revision === image.revision) { entry.url = entry.cached.data_url; entry.final = true; return; }
      const preview = await projectImagePreview(projectIconRawUrl(project.id, false, image.revision), image.media_type,
        image.size, image.revision, entry.controller.signal);
      if (!current()) return;
      entry.final = true; entry.url = preview ?? projectIconRawUrl(project.id, true, image.revision);
      if (preview) {
        const cached = { key: entry.persistentKey, project_id: project.id, revision: image.revision,
          data_url: preview, used_at: Date.now() };
        entry.cached = cached;
        void storeProjectImage(cached);
      }
    }).catch((error: unknown) => {
      if (!current()) return;
      const status = error && typeof error === "object" && "status" in error ? error.status : null;
      if (error instanceof MissingProjectImage || status === 403 || status === 404) {
        entry.outcome = "missing"; entry.final = true; entry.url = null; entry.cached = null;
        void deleteStoredProjectImage(entry.persistentKey, project.id);
      } else {
        // A temporary read failure preserves a previous preview; the resource
        // request owns authentication/reconnect reporting, never an icon badge.
        const available = entry.outcome === "hit";
        entry.outcome = "error";
        if (!entry.url && available) { entry.url = projectIconRawUrl(project.id, true, entry.resourceRevision); entry.final = true; }
      }
    }).finally(() => {
      clearTimeout(entry.deadline);
      if (entries.get(key) !== entry) return;
      entry.pending = false;
      entry.expires = Date.now() + (entry.outcome === "hit" ? HIT_TTL : MISS_TTL);
      entries.delete(key); entries.set(key, entry); bound(); notify(key);
    });
}
export function readProjectImage(key: string): string | null { return entries.get(key)?.url ?? null; }
export function subscribeProjectImage(key: string, project: Identity, listener: () => void): () => void {
  let subscribed = subscribers.get(key);
  if (!subscribed) {
    subscribed = { project: { ...project }, listeners: new Set(), timer: setInterval(() => ensure(key, project), MISS_TTL) };
    subscribers.set(key, subscribed);
  }
  subscribed.listeners.add(listener); ensure(key, subscribed.project);
  return () => {
    subscribed.listeners.delete(listener);
    if (!subscribed.listeners.size) { clearInterval(subscribed.timer); subscribers.delete(key); }
  };
}
export function rejectProjectImage(key: string, url: string): void {
  const entry = entries.get(key);
  if (entry?.url !== url) return;
  entry.url = null; entry.cached = null; entry.outcome = "error";
  entry.expires = Date.now() + MISS_TTL;
  void deleteStoredProjectImage(entry.persistentKey, entry.project.id); notify(key);
}
/** A reconnect/metadata change retries while retaining the last displayed preview. */
export function invalidateProjectImages(projectId?: string): void {
  for (const [key, entry] of entries) {
    if (projectId && entry.project.id !== projectId) continue;
    clearTimeout(entry.deadline); entry.controller.abort();
    entries.set(key, { ...entry, controller: new AbortController(), pending: false, final: false,
      outcome: "pending", deadline: undefined, expires: 0 });
    notify(key);
  }
  for (const [key, subscribed] of subscribers) {
    if (!projectId || subscribed.project.id === projectId) ensure(key, subscribed.project);
  }
}
export function forgetProjectImages(projectId: string): void {
  for (const [key, entry] of entries) if (entry.project.id === projectId) remove(key);
  void purgeStoredProjectImages(projectId);
}
export async function clearProjectImageCache(): Promise<boolean> {
  for (const key of entries.keys()) remove(key);
  const clear = clearStoredProjectImages();
  for (const [key, subscribed] of subscribers) ensure(key, subscribed.project);
  return clear;
}
