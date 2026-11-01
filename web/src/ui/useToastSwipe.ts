import { useRef, useState, type PointerEvent } from "react";

/** Bottom-right toast gestures dismiss to the right or down. Controls keep clicks. */
export function useToastSwipe(dismiss: () => void) {
  const pointer = useRef<{ id: number; x: number; y: number; axis: "x" | "y" | null; distance: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0, active: false });
  const cancel = () => { pointer.current = null; setOffset({ x: 0, y: 0, active: false }); };
  return {
    style: { translate: `${offset.x}px ${offset.y}px`, opacity: Math.max(0.15, 1 - (offset.x + offset.y) / 300),
      transition: offset.active ? "none" : undefined, touchAction: "none" as const },
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.isPrimary === false || event.target instanceof Element && event.target.closest("button,a,input,textarea,select")) return;
      pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, distance: 0 };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const tracked = pointer.current;
      if (!tracked || tracked.id !== event.pointerId) return;
      const x = Math.max(0, event.clientX - tracked.x), y = Math.max(0, event.clientY - tracked.y);
      if (!tracked.axis && Math.max(x, y) > 8) tracked.axis = x > y ? "x" : "y";
      if (!tracked.axis) return;
      event.preventDefault();
      tracked.distance = tracked.axis === "x" ? x : y;
      setOffset({ x: tracked.axis === "x" ? x : 0, y: tracked.axis === "y" ? y : 0, active: true });
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
      const tracked = pointer.current;
      if (!tracked || tracked.id !== event.pointerId) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      const size = tracked.axis === "x" ? bounds.width : bounds.height;
      const closes = tracked.axis !== null && tracked.distance >= Math.min(96, size * 0.35);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      cancel();
      if (closes) dismiss();
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
  };
}
