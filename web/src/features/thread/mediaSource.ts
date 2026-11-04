import { mediaKind, rawUrl } from "../panels/FileMedia";
import { serviceUrl } from "../../api/origin";
import { readToken } from "../../api/token";

/** A media element of a message, and everything the expanded view acts on. */
export interface MediaItem {
  kind: "image" | "video";
  /** What an element loads: a safe remote URL, the raw route, or a blob URL. */
  src: string;
  alt: string;
  /** Checkout-relative, so the raw route can serve the original bytes. */
  path?: string;
  threadId?: string;
  remoteUrl?: string;
}

/** The thread whose checkout a path in a message is read from; its cwd is the root. */
export interface MediaThread {
  id: string;
  cwd: string | null;
}

/** The one place media elements mark themselves for the expanded view to collect. */
export const MEDIA_ATTRIBUTE = "data-md-media";

/** The message container one dialog expands; a thread's other messages stay out. */
const GALLERY_SCOPE = ".md";

export function safeHref(raw: string): string | null {
  const href = raw.trim();
  // Control characters and whitespace can hide a scheme from a naive check.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\s]/.test(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[a-z]:[\\/]/i;

/** A remote address a page may draw; `safeHref` also allows mailto, which is never media. */
const remoteHref = (raw: string): string | null => {
  const href = safeHref(raw);
  return href !== null && /^https?:/i.test(href) ? href : null;
};

/** The path part of a remote address, for deciding what kind of media it names. */
const remotePath = (href: string): string => {
  try {
    return new URL(href).pathname;
  } catch {
    return "";
  }
};

/** Windows compares a drive letter without case, and nothing else in a path. */
const rootKey = (path: string) => (DRIVE.test(path) ? path.toLowerCase() : path);

/**
 * A checkout-relative path for the raw route, or null when this is not one. The
 * service refuses anything outside the checkout, so an absolute path outside the
 * thread's own root is refused here rather than shown as a broken element.
 */
export function workspacePath(raw: string, cwd: string | null): string | null {
  const destination = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!destination || /[\u0000-\u001f\s]/.test(destination)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(destination);
  } catch (failure) {
    if (!(failure instanceof URIError)) throw failure;
    // A malformed escape can be a literal filename; never decode only part of it.
    decoded = destination;
  }
  // Escaped spaces belong to filenames, but escaped controls must still be refused.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(decoded)) return null;
  const value = decoded.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  if (!value) return null;
  if (SCHEME.test(value) && !DRIVE.test(value)) return null;
  if (!value.startsWith("/") && !DRIVE.test(value)) return value;
  if (!cwd) return null;
  const root = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || rootKey(root) === rootKey(value)) return null;
  const prefix = `${rootKey(root)}/`;
  return rootKey(value).startsWith(prefix) ? value.slice(root.length + 1) : null;
}

/** What a message's media markdown resolves to, or null to leave the markdown as text. */
export function resolveMediaSource(raw: string, alt: string, thread: MediaThread | null): MediaItem | null {
  const remote = remoteHref(raw);
  if (remote) {
    if (mediaKind(remotePath(remote)) === "video") return { kind: "video", src: remote, alt };
    const query = new URLSearchParams({ url: remote });
    const token = readToken();
    if (token) query.set("token", token);
    return { kind: "image", src: serviceUrl(`/api/media/image?${query}`), remoteUrl: remote, alt };
  }
  if (!thread) return null;
  const path = workspacePath(raw, thread.cwd);
  const kind = path ? mediaKind(path) : null;
  if (!path || (kind !== "image" && kind !== "video")) return null;
  return { kind, src: rawUrl(thread.id, path), alt, path, threadId: thread.id };
}

export function mediaAttribute(item: MediaItem): string {
  return JSON.stringify(item);
}

/** Reads back one marked element; anything malformed is simply not media. */
export function readMediaAttribute(node: Element): MediaItem | null {
  const raw = node.getAttribute(MEDIA_ATTRIBUTE);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { kind, src, alt, path, threadId, remoteUrl } = value;
    if ((kind !== "image" && kind !== "video") || typeof src !== "string" || !src) return null;
    return {
      kind,
      src,
      alt: typeof alt === "string" ? alt : "",
      ...(typeof path === "string" ? { path } : {}),
      ...(typeof threadId === "string" ? { threadId } : {}),
      ...(typeof remoteUrl === "string" ? { remoteUrl } : {}),
    };
  } catch {
    return null;
  }
}

/** Every media element of the message `target` sits in, and where `target` is among them. */
export function mediaGallery(target: Element, fallback: MediaItem): { items: MediaItem[]; index: number } {
  const nodes = [...(target.closest(GALLERY_SCOPE)?.querySelectorAll(`[${MEDIA_ATTRIBUTE}]`) ?? [])];
  const items: MediaItem[] = [];
  let index = -1;
  for (const node of nodes) {
    const item = readMediaAttribute(node);
    if (!item) continue;
    if (node === target) index = items.length;
    items.push(item);
  }
  if (index < 0) {
    items.push(fallback);
    index = items.length - 1;
  }
  return { items, index };
}

/** Where Save sends the browser: the download route for checkout media, the URL itself for a blob. */
export function mediaSaveUrl(item: MediaItem): string | null {
  if (item.remoteUrl) return `${item.src}&download=true`;
  if (item.path && item.threadId) return rawUrl(item.threadId, item.path, true);
  return /^https?:/i.test(item.src) ? null : item.src;
}

/**
 * What the expanded view copies: a checkout path rather than its raw route, since
 * that URL carries the launch token and only works inside this app. A blob URL
 * lives only in this page, so it copies nothing.
 */
export function mediaCopyTarget(item: MediaItem): string | null {
  if (item.remoteUrl) return item.remoteUrl;
  if (item.path) return item.path;
  return /^https?:/i.test(item.src) ? item.src : null;
}

export function mediaFileName(item: MediaItem): string {
  return item.path?.split("/").at(-1) || item.alt.trim() || item.kind;
}

/** A refused or failed load reads as a sentence instead of a broken element. */
export const unavailableLabel = (item: MediaItem): string =>
  `${item.kind === "video" ? "Video" : "Image"} unavailable${item.alt.trim() ? ` · ${item.alt.trim()}` : ""}`;
