import { authHeaders } from "../api/client";
import type { ProjectIconMediaType } from "../generated/ProjectIconMediaType";
import { smallProjectImage } from "./projectImagePersistence";

export const PROJECT_IMAGE_MIME: Record<ProjectIconMediaType, string> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  heic: "image/heic", heif: "image/heif", tiff: "image/tiff",
};
const MAX_SOURCE = 4 * 1024 * 1024;
export class MissingProjectImage extends Error {}

async function boundedBytes(response: Response): Promise<ArrayBuffer | null> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > MAX_SOURCE) { await response.body?.cancel(); return null; }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SOURCE) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
function dataUrl(bytes: ArrayBuffer, mime: string): string {
  const view = new Uint8Array(bytes);
  const chunks: string[] = [];
  for (let at = 0; at < view.length; at += 32768) chunks.push(String.fromCharCode(...view.subarray(at, at + 32768)));
  return `data:${mime};base64,${btoa(chunks.join(""))}`;
}

/** Return a small preview, or null to let the image element stream the source. */
export async function projectImagePreview(url: string, type: ProjectIconMediaType, size: number,
  revision: string, signal: AbortSignal): Promise<string | null> {
  if (size > MAX_SOURCE) return null;
  const response = await fetch(url, { headers: authHeaders(), credentials: "same-origin", signal });
  if (response.status === 404 || response.status === 403) throw new MissingProjectImage();
  if (!response.ok) throw new Error("Project image read failed.");
  if (response.headers.get("etag") !== `"${revision}"`) {
    await response.body?.cancel();
    throw new Error("Project image changed during its read.");
  }
  const bytes = await boundedBytes(response);
  if (!bytes || signal.aborted) return null;
  const mime = PROJECT_IMAGE_MIME[type];
  const original = dataUrl(bytes, mime);
  if (smallProjectImage(original)) return original;
  // SVG stays in image mode; it is never painted through an executable document.
  if (type === "svg" || typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes], { type: mime })); }
  catch { return null; }
  try {
    if (signal.aborted || !bitmap.width || !bitmap.height) return null;
    for (const bound of [96, 48]) {
      const scale = Math.min(1, bound / bitmap.width, bound / bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const preview = canvas.toDataURL("image/webp", 0.85);
      if (smallProjectImage(preview)) return preview;
    }
    return null;
  } catch { return null; } finally { bitmap.close(); }
}
