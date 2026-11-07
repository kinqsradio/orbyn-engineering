import { ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { captureFocusReturn, moveFocus, watchOutside, type CloseCause } from "./focusReturn";
import { closingProps } from "./Presence";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  separatorBefore?: boolean;
  /** Shown right-aligned, such as the key that runs the same command. */
  shortcut?: string;
  /** Opens a submenu instead of acting. */
  children?: MenuItem[];
  onSelect?(): void;
}

/** Keeps the menu 8px inside the window, measured by layout size so the opening scale can't shrink it. */
const placed = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  if (rect.left + width > window.innerWidth - 8) element.style.left = `${Math.max(8, window.innerWidth - width - 8)}px`;
  if (rect.top + height > window.innerHeight - 8) element.style.top = `${Math.max(8, window.innerHeight - height - 8)}px`;
};

function MenuList({
  x,
  y,
  origin,
  label,
  heading,
  items,
  submenu,
  closing,
  onClose,
  onBack,
}: {
  x: number;
  y: number;
  origin: string;
  label: string;
  heading?: string;
  items: MenuItem[];
  submenu?: boolean;
  closing?: boolean;
  onClose(cause: CloseCause): void;
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
      if (onBack) onBack();
      else onClose("escape");
    } else if (event.key === "Tab") {
      event.preventDefault();
      onClose(event.shiftKey ? "shiftTab" : "tab");
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
        {...closingProps(closing)}
      >
        {heading ? <div className="menu-heading" role="presentation">{heading}</div> : null}
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
                // Focus is back on the opener before the action runs, so a dialog it opens returns there.
                onClose("select");
                item.onSelect?.();
              }}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcut ? <span className="menu-shortcut">{item.shortcut}</span> : null}
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
          closing={closing}
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

const isModal = (dialog: HTMLDialogElement) => {
  try {
    return dialog.matches(":modal");
  } catch {
    return false;
  }
};

/**
 * A modal dialog sits in the top layer, above anything in the body, so a menu opened from one
 * has to live inside it. The last open modal in document order stands in for the topmost; the
 * app never opens a second modal that sits earlier in the document than the first.
 */
function menuHost(): HTMLElement {
  const modals = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter(isModal);
  return modals.at(-1) ?? document.body;
}

/**
 * A popup at a point, scaling from its origin, with submenus. Arrow keys, Enter and Escape work.
 * Wrap it in `Presence` to fade out on close; `closing` is set by that wrapper.
 */
export function Menu({
  x,
  y,
  origin = "top left",
  label,
  heading,
  items,
  closing,
  onClose,
}: {
  x: number;
  y: number;
  origin?: "top left" | "bottom left" | "bottom right";
  label: string;
  /** A small caption above the items, such as "Hidden tabs". */
  heading?: string;
  items: MenuItem[];
  closing?: boolean;
  onClose(): void;
}) {
  // Taken as the menu opens, before it takes focus.
  const [focusReturn] = useState(() => captureFocusReturn());
  const moved = useRef(false);
  const dismiss = (cause: CloseCause, target?: EventTarget | null) => {
    if (closing || moved.current) return;
    moved.current = true;
    moveFocus(focusReturn, cause, target);
    onClose();
  };
  const latest = useRef(dismiss);
  latest.current = dismiss;

  useEffect(() => {
    // A menu that is leaving must not close the one that replaced it.
    if (closing) return;
    // Only a real user action outside closes it: a pointer press or a key pressed elsewhere, or a
    // route change. A window blur or a programmatic focus change does not.
    return watchOutside(
      (target) => !!(target as Element | null)?.closest?.("[data-menu-root]"),
      (cause, target) => latest.current(cause, target),
    );
  }, [closing]);

  // Closed from outside (the trigger toggling it): the same as Escape, unless focus moved on already.
  useLayoutEffect(() => {
    if (!closing || moved.current) return;
    moved.current = true;
    const active = document.activeElement;
    if (!active || active === document.body || active.closest("[data-menu-root]")) focusReturn.restore();
  }, [closing, focusReturn]);

  // Chosen once, so a dialog opening or closing behind the menu doesn't remount it.
  const [host] = useState(menuHost);
  return createPortal(
    <MenuList x={x} y={y} origin={origin} label={label} heading={heading} items={items} closing={closing} onClose={dismiss} />,
    host,
  );
}
