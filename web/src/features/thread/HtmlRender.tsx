import { Maximize2 } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";
import { resolveTheme, useUi } from "../../state/ui";
import { Button } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import { isHtmlRenderTool, renderFrameFrom, type RenderFrame } from "./renderFrame";
import type { ToolItem } from "../../state/thread/projection";

/** Zoom is a percentage of the frame's own layout: 50% to 200%. */
const MIN_ZOOM = 50;
const MAX_ZOOM = 200;
const ZOOM_STEP = 25;

interface FrameProps {
  frame: RenderFrame;
  colorScheme: "light" | "dark";
  /** A percentage over the frame's laid-out size; 100 is the frame as published. */
  zoom?: number;
}

/**
 * A published page. The sandbox carries `allow-scripts` and never
 * `allow-same-origin`, so the page runs its own inline script in an opaque origin:
 * no storage, no cookie, no API of this app. Its URL carries only this render's
 * frame token, and `no-referrer` keeps it out of anything the page links to.
 */
function Frame({ frame, colorScheme, zoom = 100 }: FrameProps) {
  const scale = zoom / 100;
  // Zoom the page, not its box: the frame lays out at 1/scale and the transform scales
  // it back, so the height the card asks for stays the height on screen and the page's
  // own viewport shrinks the way a browser's zoom does.
  const style: CSSProperties = {
    colorScheme,
    width: `${100 / scale}%`,
    height: frame.height / scale,
    ...(scale === 1 ? {} : { transform: `scale(${scale})`, transformOrigin: "top left" as const }),
  };
  return (
    <iframe
      className="render-frame"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={frame.title}
      src={frame.src}
      style={style}
    />
  );
}

/** The expanded view: the same page, larger, with a zoom control. */
function RenderDialog({
  frame,
  colorScheme,
  onClose,
}: {
  frame: RenderFrame;
  colorScheme: "light" | "dark";
  onClose(): void;
}) {
  const [zoom, setZoom] = useState(100);
  const zoomId = useId();
  return (
    <Dialog title={frame.title} className="dialog-wide" onClose={onClose}>
      <div className="render-zoom">
        <label htmlFor={zoomId}>Zoom</label>
        <input
          id={zoomId}
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={ZOOM_STEP}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <output htmlFor={zoomId}>{zoom}%</output>
      </div>
      <div className="render-stage" style={{ height: frame.height }}>
        <Frame frame={frame} colorScheme={colorScheme} zoom={zoom} />
      </div>
    </Dialog>
  );
}

/**
 * The card a finished `orbyn_html_render` row shows: the page in a titled frame with
 * a way to open it. It sits beside the row's collapsible body rather than inside it,
 * so the card is there whether or not the call's details are open. The thread comes
 * from the row, because a frame's route is built from it.
 */
export function HtmlRender({ item, threadId }: { item: ToolItem; threadId: string | null }) {
  const colorScheme = resolveTheme(useUi((state) => state.theme));
  const [open, setOpen] = useState(false);
  const frame = isHtmlRenderTool(item.name) ? renderFrameFrom(item.result, threadId) : null;
  if (!frame) return null;
  return (
    <figure className="render-card">
      <figcaption>
        <span className="render-title" title={frame.title}>
          {frame.title}
        </span>
        <Button small tone="quiet" icon={<Maximize2 size={14} aria-hidden />} onClick={() => setOpen(true)}>
          Open
        </Button>
      </figcaption>
      <div className="render-body" style={{ height: frame.height }}>
        <Frame frame={frame} colorScheme={colorScheme} />
      </div>
      {open ? <RenderDialog frame={frame} colorScheme={colorScheme} onClose={() => setOpen(false)} /> : null}
    </figure>
  );
}