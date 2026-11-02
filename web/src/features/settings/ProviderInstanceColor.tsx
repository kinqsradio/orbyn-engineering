import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Plus } from "lucide-react";
import { Button, Field } from "../../ui/controls";
import { accentColor } from "./providerInstanceData";
export interface Hsv { h: number; s: number; v: number }
const clamp = (value: number) => Math.min(1, Math.max(0, value));
export function hsvHex({ h, s, v }: Hsv): string {
  const chroma = clamp(v) * clamp(s), sector = ((h % 360 + 360) % 360) / 60;
  const middle = chroma * (1 - Math.abs(sector % 2 - 1));
  const channels = [[chroma, middle, 0], [middle, chroma, 0], [0, chroma, middle], [0, middle, chroma], [middle, 0, chroma], [chroma, 0, middle]][Math.floor(sector)]!;
  return `#${channels.map((value) => Math.round((value + clamp(v) - chroma) * 255).toString(16).padStart(2, "0")).join("")}`;
}
export function hexHsv(hex: string): Hsv {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels as [number, number, number];
  const max = Math.max(...channels), min = Math.min(...channels), delta = max - min;
  const sector = delta === 0 ? 0 : max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (sector * 60 + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function ProviderInstanceColor({ value, name, disabled, save }: { value: string; name: string; disabled: boolean; save(value: string): void }) {
  const anchor = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [hsv, setHsv] = useState<Hsv>(() => hexHsv(accentColor(value) ?? "#2563eb"));
  const [hex, setHex] = useState<string | null>(null);
  const [seen, setSeen] = useState(value), [preview, setPreview] = useState<string | null>(null);
  const latest = useRef({ disabled, save }); latest.current = { disabled, save };
  const restoreFocus = useRef(false);
  const dragging = useRef<{ pointer: number; color: string } | null>(null);
  if (seen !== value) { setSeen(value); setPreview(null); setHex(null); setHsv(hexHsv(accentColor(value) ?? "#2563eb")); dragging.current = null; }
  const close = () => {
    const pending = dragging.current; dragging.current = null;
    if (pending && !disabled) save(pending.color);
    restoreFocus.current = true; setOpen(false); if (!disabled) anchor.current?.querySelector("button")?.focus();
  };
  useLayoutEffect(() => {
    if (!open && !disabled && restoreFocus.current) { restoreFocus.current = false; anchor.current?.querySelector("button")?.focus(); }
  }, [open, disabled]);
  useLayoutEffect(() => {
    if (!open || !popup.current) return;
    const element = popup.current;
    element.showPopover?.();
    const place = () => {
      const button = anchor.current?.getBoundingClientRect(); if (!button) return;
      const size = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(button.left, innerWidth - size.width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(button.bottom + 6 + size.height <= innerHeight - 8 ? button.bottom + 6 : button.top - size.height - 6, innerHeight - size.height - 8))}px`;
    };
    place(); element.querySelector<HTMLInputElement>("input[type=range]")?.focus();
    const dismiss = (focus: boolean) => {
      const pending = dragging.current; dragging.current = null;
      if (pending && !latest.current.disabled) latest.current.save(pending.color);
      restoreFocus.current = focus; setOpen(false); if (focus && !latest.current.disabled) anchor.current?.querySelector("button")?.focus();
    };
    const outside = (event: MouseEvent) => { if (event.target instanceof Node && !element.contains(event.target) && !anchor.current?.contains(event.target)) dismiss(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(true); } };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape, true); window.addEventListener("scroll", place, true); window.addEventListener("resize", place);
    return () => { element.hidePopover?.(); document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape, true); window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open]);
  const change = (next: Hsv) => { setHsv(next); setHex(null); const color = hsvHex(next); setPreview(color); if (dragging.current) dragging.current.color = color; else save(color); };
  const point = (event: PointerEvent<HTMLDivElement>, hue: boolean) => {
    if (disabled || dragging.current?.pointer !== event.pointerId) return;
    const box = event.currentTarget.getBoundingClientRect();
    change(hue ? { ...hsv, h: clamp((event.clientX - box.left) / box.width) * 360 }
      : { ...hsv, s: clamp((event.clientX - box.left) / box.width), v: 1 - clamp((event.clientY - box.top) / box.height) });
  };
  const start = (event: PointerEvent<HTMLDivElement>, hue: boolean) => {
    if (disabled || event.button !== 0) return;
    dragging.current = { pointer: event.pointerId, color: hsvHex(hsv) }; event.currentTarget.setPointerCapture(event.pointerId); point(event, hue);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current?.pointer !== event.pointerId) return;
    const color = dragging.current.color; dragging.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!disabled) save(color);
  };
  const normalized = accentColor(preview ?? value);
  return <div className="provider-accent" ref={anchor}>
    <Button small disabled={disabled} aria-expanded={open} aria-label={`${normalized ? "Change" : "Add"} accent color for ${name}`} onClick={() => { if (open) { close(); return; } setHsv(hexHsv(normalized ?? "#2563eb")); setHex(null); setOpen(true); }}>
      {normalized ? <span className="provider-accent-swatch" style={{ backgroundColor: normalized }} aria-hidden /> : <Plus size={16} aria-hidden />}</Button>
    {open ? <div ref={popup} popover="manual" className="provider-accent-popup" role="dialog" aria-label="Accent color">
      <div className="provider-color-plane" role="group" aria-label="Accent color saturation and brightness" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        onPointerDown={(event) => start(event, false)} onPointerMove={(event) => point(event, false)} onPointerUp={finish} onPointerCancel={finish}>
        {(["s", "v"] as const).map((axis) => <input className="sr-only" key={axis} type="range" min="0" max="100" step="any"
          aria-label={`Accent color ${axis === "s" ? "saturation" : "brightness"}`} aria-valuetext={`${Math.round(hsv[axis] * 100)}%`} value={hsv[axis] * 100} disabled={disabled}
          onChange={(event) => change({ ...hsv, [axis]: event.target.valueAsNumber / 100 })} onKeyDown={(event) => {
            if (event.key === "Home" || event.key === "End" || event.key.startsWith("Arrow")) {
              event.preventDefault(); const delta = (event.shiftKey ? 10 : 1) / 100;
              const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : hsv[axis] + (event.key === "ArrowUp" || event.key === "ArrowRight" ? delta : -delta);
              change({ ...hsv, [axis]: clamp(next) });
            }
          }} />)}
        <span className="provider-color-cursor" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} aria-hidden />
      </div>
      <div className="provider-color-body"><div className="provider-color-hue" role="slider" tabIndex={disabled ? -1 : 0} aria-label="Accent color hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} aria-disabled={disabled}
        onPointerDown={(event) => start(event, true)} onPointerMove={(event) => point(event, true)} onPointerUp={finish} onPointerCancel={finish}
        onKeyDown={(event) => { if (disabled) return; const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
          if (direction) { event.preventDefault(); change({ ...hsv, h: (hsv.h + direction * (event.shiftKey ? 10 : 1) + 360) % 360 }); } }}>
        <span className="provider-hue-cursor" style={{ left: `${hsv.h / 360 * 100}%` }} aria-hidden /></div>
        <Field label="Custom hex accent color">{(props) => <input {...props} disabled={disabled} spellCheck={false} value={hex ?? hsvHex(hsv)} onBlur={() => setHex(null)}
          onChange={(event) => { const next = event.target.value; setHex(next); const color = accentColor(next); if (color) { setHsv(hexHsv(color)); setPreview(color); save(color); } }} />}</Field>
        {normalized ? <Button small disabled={disabled} onClick={() => { setPreview(""); save(""); setOpen(false); }}>Clear color</Button>
          : <Button small disabled={disabled} onClick={() => { setPreview(hsvHex(hsv)); save(hsvHex(hsv)); setOpen(false); }}>Add color</Button>}
      </div>
    </div> : null}
  </div>;
}
