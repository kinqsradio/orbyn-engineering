import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
  /** Opens a submenu instead of acting. */
  children?: MenuItem[];
  onSelect?(): void;
}

const placed = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  if (rect.right > window.innerWidth - 8) element.style.left = `${window.innerWidth - rect.width - 8}px`;
  if (rect.bottom > window.innerHeight - 8) element.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
};

function MenuList({
  x,
  y,
  origin,
  label,
  items,
  submenu,
  onClose,
  onBack,
}: {
  x: number;
  y: number;
  origin: string;
  label: string;
  items: MenuItem[];
  submenu?: boolean;
  onClose(): void;
  onBack?(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ item: MenuItem; x: number; y: number } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    placed(element);
    element.querySelector<HTMLElement>(":scope > button:not(:disabled)")?.focus();
  }, []);

  const openSubmenu = (item: MenuItem, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const fits = rect.right + 200 < window.innerWidth;
    setOpen({ item, x: fits ? rect.right + 4 : rect.left - 204, y: rect.top - 4 });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (open) return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>(":scope > button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      (onBack ?? onClose)();
    } else if (event.key === "ArrowLeft" && submenu) {
      event.preventDefault();
      event.stopPropagation();
      onBack?.();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "ArrowRight") {
      const button = buttons[at];
      const item = items.find((entry) => entry.label === button?.dataset.label);
      if (button && item?.children) {
        event.preventDefault();
        openSubmenu(item, button);
      }
    }
  };

  return (
    <>
      <div
        ref={ref}
        className="popup-menu"
        role="menu"
        aria-label={label}
        data-menu-root
        style={{ left: x, top: y, transformOrigin: origin }}
        data-origin={origin}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => (
          <FragmentRow key={item.label} separator={item.separatorBefore === true && index > 0}>
            <button
              type="button"
              role="menuitem"
              data-label={item.label}
              data-destructive={item.destructive || undefined}
              aria-haspopup={item.children ? "menu" : undefined}
              aria-expanded={item.children ? open?.item === item : undefined}
              disabled={item.disabled}
              aria-current={item.selected || undefined}
              onPointerEnter={(event) => {
                clearTimeout(hoverTimer.current);
                const button = event.currentTarget;
                hoverTimer.current = setTimeout(() => {
                  if (item.children && !item.disabled) openSubmenu(item, button);
                  else setOpen(null);
                }, 100);
              }}
              onClick={(event) => {
                if (item.children) {
                  openSubmenu(item, event.currentTarget);
                  return;
                }
                onClose();
                item.onSelect?.();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.children ? <ChevronRight size={14} className="menu-chev" aria-hidden /> : null}
            </button>
          </FragmentRow>
        ))}
      </div>
      {open?.item.children ? (
        <MenuList
          x={open.x}
          y={open.y}
          origin="top left"
          label={open.item.label}
          items={open.item.children}
          submenu
          onClose={onClose}
          onBack={() => {
            const label = open.item.label;
            setOpen(null);
            ref.current?.querySelector<HTMLElement>(`[data-label="${CSS.escape(label)}"]`)?.focus();
          }}
        />
      ) : null}
    </>
  );
}

function FragmentRow({ separator, children }: { separator: boolean; children: ReactNode }) {
  return (
    <>
      {separator ? <hr className="menu-separator" /> : null}
      {children}
    </>
  );
}

/** A popup at a point, scaling from its origin, with submenus. Arrow keys, Enter and Escape work. */
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
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.("[data-menu-root]")) onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  return createPortal(
    <MenuList x={x} y={y} origin={origin} label={label} items={items} onClose={onClose} />,
    document.body,
  );
}
