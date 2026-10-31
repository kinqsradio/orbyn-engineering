import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

/** A popup at a point, scaling from its origin. Arrow keys, Enter and Escape work. */
export function Menu({
  x,
  y,
  origin = "top left",
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  origin?: "top left" | "bottom left" | "bottom right";
  label: string;
  items: MenuItem[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) element.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight - 8) element.style.top = `${window.innerHeight - rect.height - 8}px`;
    element.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, []);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="popup-menu"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y, transformOrigin: origin }}
      data-origin={origin}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          aria-current={item.selected || undefined}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
