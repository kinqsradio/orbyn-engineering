import { Minus, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "../../ui/controls";

const STEP = 0.25;

/** The expanded view. The image is a remote URL; only local content runs in this page. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={alt || "Image"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="lightbox-bar">
        <IconButton label="Zoom out" onClick={() => setZoom((value) => Math.max(0.25, value - STEP))}>
          <Minus size={16} aria-hidden />
        </IconButton>
        <output>{Math.round(zoom * 100)}%</output>
        <IconButton label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value + STEP))}>
          <Plus size={16} aria-hidden />
        </IconButton>
        <IconButton label="Close image" onClick={onClose}>
          <X size={16} aria-hidden />
        </IconButton>
      </div>
      <div className="lightbox-stage">
        <img src={src} alt={alt} style={{ transform: `scale(${zoom})` }} />
      </div>
    </dialog>
  );
}

export function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="md-image-failed">{alt || src}</span>;
  return (
    <>
      <button type="button" className="md-image" aria-label={`Expand ${alt || "image"}`} onClick={() => setOpen(true)}>
        <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
      </button>
      {open ? <Lightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
