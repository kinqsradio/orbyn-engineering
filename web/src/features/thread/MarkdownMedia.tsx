import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Link2, Maximize2, Minus, Plus, X } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton, LinkButton } from "../../ui/controls";
import {
  mediaAttribute,
  mediaCopyTarget,
  mediaFileName,
  mediaGallery,
  mediaSaveUrl,
  resolveMediaSource,
  unavailableLabel,
  type MediaItem,
  type MediaThread,
} from "./mediaSource";

/** The thread whose checkout a message's relative media paths are read from. */
export const MarkdownThreadContext = createContext<MediaThread | null>(null);

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;

const toast = (text: string) => useUi.getState().pushToast(text);

const toastFailure = (what: string, failure: unknown) =>
  toast(`Couldn't ${what}. ${failure instanceof Error && failure.message ? failure.message : toFailure(failure).message}`);

const canWriteImages = () =>
  typeof navigator !== "undefined" &&
  Boolean(navigator.clipboard?.write) &&
  typeof ClipboardItem !== "undefined";

/** PNG is the only clipboard image type browsers agree on, so other bytes are redrawn. */
async function pngBytes(src: string): Promise<Blob> {
  const response = await fetch(src, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`The image answered ${response.status}.`);
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;
  if (typeof createImageBitmap !== "function") throw new Error("This browser cannot redraw the image.");
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot redraw the image.");
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("This browser cannot redraw the image.");
    return png;
  } finally {
    bitmap.close();
  }
}

/** What a media element answers to when its author left the alt text out. */
const named = (item: MediaItem) => item.alt.trim() || item.kind;
const titled = (item: MediaItem) => item.alt.trim() || (item.kind === "video" ? "Video" : "Image");

function Unavailable({ item }: { item: MediaItem }) {
  return <span className="md-media-failed">{unavailableLabel(item)}</span>;
}

/**
 * The expanded view of one message's media: every marked element of the `.md`
 * container the click landed in, with the actions its bytes allow. Zoom, the
 * counter and the arrow keys all address the same item the stage shows.
 */
export function MediaDialog({ items, index: start, opener: trigger, onClose }: { items: readonly MediaItem[]; index: number; opener?: HTMLElement | null; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState(start);
  const [zooms, setZooms] = useState<Record<number, number>>({});
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog?.showModal();
    return () => {
      // Close before the portal is removed, then restore the surviving opener.
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [trigger]);
  const item = items[at];
  if (!item) return null;
  const many = items.length > 1;
  const zoom = zooms[at] ?? 1;
  const setZoom = (value: number) => setZooms((current) => ({ ...current, [at]: value }));
  const move = (by: number) => {
    setFailed(false);
    setAt((value) => (value + by + items.length) % items.length);
  };
  const isImage = item.kind === "image";
  const save = mediaSaveUrl(item);
  const copyTarget = mediaCopyTarget(item);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    // Native controls retarget their key events to the video, whose arrows seek.
    if (event.target instanceof HTMLVideoElement) return;
    if (event.key === "ArrowLeft" && many) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "ArrowRight" && many) {
      event.preventDefault();
      move(1);
    }
  };
  const copyLink = () => {
    if (!copyTarget || !clipboard?.writeText) return;
    clipboard.writeText(copyTarget).then(
      () => toast(item.path ? "Path copied" : "Link copied"),
      (failure: unknown) => toastFailure("copy the link", failure),
    );
  };
  const copyImage = () => {
    if (!clipboard || typeof ClipboardItem === "undefined") return;
    // Started inside the click, since the clipboard needs the gesture; the PNG is awaited by the browser.
    clipboard.write([new ClipboardItem({ "image/png": pngBytes(item.src) })]).then(
      () => toast("Image copied"),
      (failure: unknown) => toastFailure("copy the image", failure),
    );
  };
  return createPortal(
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={titled(item)}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="lightbox-bar">
        {many ? (
          <>
            <IconButton label="Previous" onClick={() => move(-1)}>
              <ChevronLeft size={16} aria-hidden />
            </IconButton>
            <output className="lightbox-readout">{`${at + 1} of ${items.length}`}</output>
            <IconButton label="Next" onClick={() => move(1)}>
              <ChevronRight size={16} aria-hidden />
            </IconButton>
          </>
        ) : null}
        <IconButton label="Zoom out" disabled={!isImage} onClick={() => setZoom(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))}>
          <Minus size={16} aria-hidden />
        </IconButton>
        <output className="lightbox-readout">{`${Math.round(zoom * 100)}%`}</output>
        <IconButton label="Zoom in" disabled={!isImage} onClick={() => setZoom(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <IconButton
          label={item.path ? "Copy path" : "Copy link"}
          disabled={!copyTarget || !clipboard?.writeText}
          onClick={copyLink}
        >
          <Link2 size={16} aria-hidden />
        </IconButton>
        <IconButton label="Copy image" disabled={!isImage || !canWriteImages()} onClick={copyImage}>
          <Copy size={16} aria-hidden />
        </IconButton>
        {save ? (
          <LinkButton
            small
            href={save}
            download={mediaFileName(item)}
            icon={<Download size={16} aria-hidden />}
            onClick={() => toast("Download started")}
          >
            Save
          </LinkButton>
        ) : (
          // A cross-origin download cannot be forced honestly, so remote media opens instead.
          <LinkButton small href={item.src} target="_blank" rel="noreferrer noopener" icon={<ExternalLink size={16} aria-hidden />}>
            Open in new tab
          </LinkButton>
        )}
        <IconButton label="Close" onClick={onClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div className="lightbox-stage">
        {failed ? (
          <Unavailable item={item} />
        ) : item.kind === "video" ? (
          <video src={item.src} controls preload="metadata" aria-label={named(item)} onError={() => setFailed(true)} />
        ) : (
          <img src={item.src} alt={item.alt} style={{ transform: `scale(${zoom})` }} onError={() => setFailed(true)} />
        )}
      </div>
    </dialog>,
    document.body,
  );
}

/** One image on its own, for a caller that already holds the bytes of a sent attachment. */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  return <MediaDialog items={[{ kind: "image", src, alt }]} index={0} onClose={onClose} />;
}

/**
 * One image or video of a message. A source this cannot show stays the literal
 * markdown text, and a load the service refuses reads as a sentence.
 */
export function MarkdownMedia({ source, alt, fallback }: { source: string; alt: string; fallback: ReactNode }) {
  const thread = useContext(MarkdownThreadContext);
  const item = useMemo(() => resolveMediaSource(source, alt, thread), [source, alt, thread]);
  const frame = useRef<HTMLSpanElement | null>(null);
  const [expanded, setExpanded] = useState<{ items: MediaItem[]; index: number; opener: HTMLElement } | null>(null);
  const [failed, setFailed] = useState(false);
  if (!item) return <>{fallback}</>;
  if (failed) return <Unavailable item={item} />;
  const expand = (target: Element | null, opener: HTMLElement) => {
    if (target) setExpanded({ ...mediaGallery(target, item), opener });
  };
  const dialog = expanded ? (
    <MediaDialog items={expanded.items} index={expanded.index} opener={expanded.opener} onClose={() => setExpanded(null)} />
  ) : null;
  if (item.kind === "video") {
    return (
      <>
        <span ref={frame} className="md-video" data-md-media={mediaAttribute(item)}>
          <video src={item.src} controls preload="metadata" aria-label={named(item)} onError={() => setFailed(true)} />
          <IconButton className="md-media-expand" label={`Expand ${named(item)}`} onClick={(event) => expand(frame.current, event.currentTarget)}>
            <Maximize2 size={14} aria-hidden />
          </IconButton>
        </span>
        {dialog}
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        className="md-image"
        data-md-media={mediaAttribute(item)}
        aria-label={`Expand ${named(item)}`}
        onClick={(event) => expand(event.currentTarget, event.currentTarget)}
      >
        <img src={item.src} alt={item.alt} loading="lazy" onError={() => setFailed(true)} />
      </button>
      {dialog}
    </>
  );
}
