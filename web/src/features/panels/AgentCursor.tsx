import { MousePointer2 } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";
import { serviceSocketUrl } from "../../api/origin";
import { readToken } from "../../api/token";
import type { PreviewPointer } from "../../generated/PreviewPointer";
import { MOTION } from "../../lib/motion";
import { usePrefersReducedMotion } from "../../lib/useLayout";

/** Validate at the transport boundary; old or malformed cues never move the mark. */
export function readPointer(text: string, previous: number): PreviewPointer | null {
  try {
    const event = JSON.parse(text) as PreviewPointer;
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= previous ||
        !["move", "click", "clear"].includes(event.phase) ||
        !Number.isInteger(event.width) || !Number.isInteger(event.height) ||
        event.width < 100 || event.width > 4096 || event.height < 100 || event.height > 4096 ||
        !Number.isFinite(event.x) || !Number.isFinite(event.y) ||
        event.x < 0 || event.y < 0 || event.x > event.width || event.y > event.height) return null;
    return event;
  } catch { return null; }
}

export function cursorPoint(event: PreviewPointer, width: number, height: number) {
  const scale = Math.min(width / event.width, height / event.height);
  return { left: event.x * scale, top: event.y * scale };
}

/** Content-free, short-lived input cue, independent of the JPEG connection. */
export function AgentCursor({ threadId, tabId, image }: {
  threadId: string; tabId: string; image: RefObject<HTMLImageElement | null>;
}) {
  const [event, setEvent] = useState<PreviewPointer | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // The cue lasts the dwell plus the ring (400 + 300 ms). Reduced motion keeps a static
  // ring for the dwell alone.
  const reduced = usePrefersReducedMotion();
  const lifeMs = reduced ? MOTION.wait : MOTION.wait + MOTION.slow;
  useEffect(() => {
    const element = image.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [image]);
  useEffect(() => {
    const token = readToken();
    const path = `/ws/preview/${encodeURIComponent(threadId)}/${encodeURIComponent(tabId)}/pointer`;
    const socket = new WebSocket(serviceSocketUrl(`${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`));
    let sequence = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    socket.onmessage = (message) => {
      const next = readPointer(String(message.data), sequence);
      if (!next) return;
      sequence = next.sequence;
      clearTimeout(timer);
      setEvent(next.phase === "clear" ? null : next);
      timer = setTimeout(() => setEvent(null), lifeMs);
    };
    socket.onclose = () => setEvent(null);
    return () => {
      clearTimeout(timer);
      socket.onmessage = null;
      socket.onclose = null;
      socket.close();
    };
  }, [threadId, tabId, lifeMs]);
  if (!event) return null;
  const point = cursorPoint(event, size.width, size.height);
  return <span className="browser-agent-cursor" data-agent-browser-cursor aria-hidden style={point}>
    {event.phase === "click" ? <span key={event.sequence} className="browser-agent-click" /> : null}
    <MousePointer2 size={20} />
  </span>;
}
