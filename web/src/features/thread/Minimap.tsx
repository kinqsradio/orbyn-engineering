import { useEffect, useState, type RefObject } from "react";

export interface MinimapItem {
  key: string;
  text: string;
}

const SPACING = 8;
const MIN_ITEMS = 2;

/** One tick per prompt beside the conversation. Hover previews; a click goes there. */
export function Minimap({ items, scroller }: { items: readonly MinimapItem[]; scroller: RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<MinimapItem | null>(null);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top + element.clientHeight / 3;
      let current: string | null = null;
      for (const item of items) {
        const row = element.querySelector(`[data-minimap="${CSS.escape(item.key)}"]`);
        if (row && row.getBoundingClientRect().top <= top) current = item.key;
      }
      setActive(current);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    return () => element.removeEventListener("scroll", update);
  }, [items, scroller]);
  if (items.length < MIN_ITEMS) return null;
  // Hidden until the pointer reaches the edge, so a short thread shows no stray ticks.
  return (
    <div className="minimap-zone" onWheel={(event) => scroller.current?.scrollBy(0, event.deltaY)}>
      <nav
        className="minimap"
        aria-label="Prompts in this thread"
        style={{ height: `min(${(items.length - 1) * SPACING}px, calc(100vh - 18rem))` }}
      >
        {items.map((item, at) => (
          <button
            key={item.key}
            type="button"
            aria-label={`Go to prompt: ${item.text.slice(0, 80)}`}
            aria-current={item.key === active || undefined}
            style={{ top: `${items.length > 1 ? (at / (items.length - 1)) * 100 : 0}%` }}
            onPointerEnter={() => setHover(item)}
            onPointerLeave={() => setHover(null)}
            onClick={() =>
              scroller.current
                ?.querySelector(`[data-minimap="${CSS.escape(item.key)}"]`)
                ?.scrollIntoView({ block: "start" })
            }
          />
        ))}
        {hover ? <p className="minimap-preview">{hover.text.slice(0, 160)}</p> : null}
      </nav>
    </div>
  );
}
