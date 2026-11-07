import { Check, ChevronDown, Search, Star } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { EngineStatus } from "../../api/types";
import { useCommand } from "../../app/shortcuts";
import { useUi } from "../../state/ui";
import { EngineGlyph } from "../../ui/badges";
import { closingProps, Presence } from "../../ui/Presence";
import { usePopover } from "../../ui/usePopover";
import { modKeyLabel } from "../workspace/threadUndo";
import {
  arrangeModels,
  modelKey,
  resolveModel,
  searchRows,
  shortModelName,
  useEngineModels,
  useModelStore,
  type PickerRow,
} from "../../state/modelStore";

const MARGIN = 6;
const GAP = 4;
const FAVORITES = "favorites";

export type FloatingSide = "below" | "above" | "beside";

/** Below, above, then beside the trigger, kept inside the window, as the reference does. */
export function chooseSide(anchor: DOMRect, height: number, viewport: { height: number }): FloatingSide {
  if (anchor.bottom + GAP + height <= viewport.height - MARGIN) return "below";
  if (anchor.top - GAP - height >= MARGIN) return "above";
  return "beside";
}

/** Where the panel goes on a side. The side stays put while the content's height changes. */
export function placeFloating(
  anchor: DOMRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: FloatingSide = chooseSide(anchor, size.height, viewport),
): { left: number; top: number; origin: string } {
  const clampLeft = (left: number) => Math.max(MARGIN, Math.min(viewport.width - size.width - MARGIN, left));
  const clampTop = (top: number) => Math.max(MARGIN, Math.min(viewport.height - size.height - MARGIN, top));
  if (side === "below") return { left: clampLeft(anchor.left), top: clampTop(anchor.bottom + GAP), origin: "top left" };
  if (side === "above") {
    return { left: clampLeft(anchor.left), top: clampTop(anchor.top - GAP - size.height), origin: "bottom left" };
  }
  return { left: clampLeft(anchor.left - GAP - size.width), top: clampTop(anchor.top), origin: "right center" };
}

export function FloatingPanel({
  anchor,
  label,
  className,
  container,
  closing,
  panelRef,
  children,
}: {
  anchor: DOMRect;
  label: string;
  className: string;
  container?: HTMLElement | null;
  /** Set by `Presence` while the panel fades out: it takes no focus or pointer. */
  closing?: boolean;
  /** The panel's element, for `usePopover`, which owns closing and focus. */
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const ref = panelRef;
  const side = useRef<FloatingSide | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // Chosen once, for the tallest it can get, so switching tabs cannot move it.
    const tallest = Math.max(element.offsetHeight, Number.parseFloat(getComputedStyle(element).maxHeight) || 0);
    side.current ??= chooseSide(anchor, tallest, viewport);
    const place = placeFloating(
      anchor,
      { width: element.offsetWidth, height: element.offsetHeight },
      viewport,
      side.current,
    );
    element.style.left = `${place.left}px`;
    element.style.top = `${place.top}px`;
    element.style.transformOrigin = place.origin;
  });
  return createPortal(
    <div ref={ref} className={className} role="dialog" aria-label={label} {...closingProps(closing)}>
      {children}
    </div>,
    container ?? document.body,
  );
}

function useHeldMod() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const sync = (event: KeyboardEvent) => setHeld(event.metaKey || event.ctrlKey);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
    };
  }, []);
  return held;
}

interface Selection {
  engine: string;
  model: string | null;
}

function Rows({
  rows,
  active,
  selected,
  extra,
  showEngine,
  jumps,
  engineName,
  favorites,
  onHover,
  onPick,
  onFavorite,
}: {
  rows: PickerRow[];
  active: number;
  selected: Selection;
  extra: readonly Selection[];
  showEngine: boolean;
  jumps: boolean;
  engineName(engine: string): string;
  favorites: readonly string[];
  onHover(index: number): void;
  onPick(row: PickerRow, adding: boolean): void;
  onFavorite(row: PickerRow): void;
}) {
  return (
    <div className="model-rows" role="listbox" aria-label="Models">
      {rows.map((row, index) => {
        const key = modelKey(row.engine, row.model.id);
        const favorite = favorites.includes(key);
        const isSelected = [selected, ...extra].some(
          (entry) => row.engine === entry.engine && row.model.id === entry.model,
        );
        return (
          <div
            key={key}
            role="option"
            aria-selected={isSelected}
            className="model-row"
            data-active={index === active || undefined}
            onPointerMove={() => onHover(index)}
            onClick={(event) => onPick(row, event.shiftKey)}
          >
            <div className="model-row-text">
              <span>{row.model.label}</span>
              {showEngine ? (
                <small>
                  <EngineGlyph name={engineName(row.engine)} />
                  {engineName(row.engine)}
                </small>
              ) : null}
            </div>
            {jumps && index < 9 ? (
              <kbd>
                {modKeyLabel()}
                {index + 1}
              </kbd>
            ) : null}
            <button
              type="button"
              className="model-star"
              data-on={favorite || undefined}
              aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
              title={favorite ? "Remove from favorites" : "Add to favorites"}
              onClick={(event) => {
                event.stopPropagation();
                onFavorite(row);
              }}
            >
              <Star size={12} fill={favorite ? "currentColor" : "none"} aria-hidden />
            </button>
            <Check size={14} className="model-check" data-on={isSelected || undefined} aria-hidden />
          </div>
        );
      })}
    </div>
  );
}

function ModelPopover({
  engines,
  selected,
  extra,
  anchor,
  portalContainer,
  disabledReason,
  trigger,
  onPick,
  onToggleExtra,
  closing,
  onClose,
}: {
  engines: EngineStatus[];
  selected: Selection;
  extra: readonly Selection[];
  anchor: DOMRect;
  closing?: boolean;
  portalContainer?: HTMLElement | null;
  disabledReason?(engine: EngineStatus): string | null;
  /** The button that opened it, where focus returns. */
  trigger(): HTMLElement | null | undefined;
  onPick(selection: Selection): void;
  /** Shift-click adds a model, for starting one thread on each. */
  onToggleExtra?(selection: Selection): void;
  onClose(): void;
}) {
  const favorites = useUi((state) => state.modelFavorites);
  const hidden = useUi((state) => state.modelHidden);
  const order = useUi((state) => state.modelOrder);
  const setPrefs = useUi((state) => state.setPrefs);
  const byEngine = useModelStore((state) => state.byEngine);
  const load = useModelStore((state) => state.load);
  const [tab, setTab] = useState(selected.engine);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  // Two panes, rail then search: Tab goes rail -> search and closes after it; Shift+Tab the reverse.
  const panes = [
    { root: rail, focus: () => rail.current?.querySelector<HTMLElement>("[aria-pressed=true]")?.focus() },
    { root: main, focus: () => input.current?.focus() },
  ];
  const popover = usePopover({
    kind: "menu",
    root: panel,
    trigger,
    closing,
    panes,
    onClose,
  });
  const jumps = useHeldMod();

  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
    for (const engine of engines) void load(engine.id);
  }, [engines, load]);

  const engineName = useCallback(
    (id: string) => engines.find((engine) => engine.id === id)?.name ?? id,
    [engines],
  );
  const allRows = useMemo(
    () =>
      engines.flatMap((engine) =>
        arrangeModels(engine.id, byEngine[engine.id]?.models ?? [], hidden, order).map((model) => ({
          engine: engine.id,
          model,
        })),
      ),
    [engines, byEngine, hidden, order],
  );
  const searching = query.trim() !== "";
  const rows = searching
    ? searchRows(allRows, query)
    : tab === FAVORITES
      ? allRows.filter((row) => favorites.includes(modelKey(row.engine, row.model.id)))
      : allRows.filter((row) => row.engine === tab);
  const tabs = [FAVORITES, ...engines.map((engine) => engine.id)];
  const pick = (row: PickerRow, adding = false) => {
    const choice = { engine: row.engine, model: row.model.id };
    if (adding && onToggleExtra) {
      if (choice.engine !== selected.engine || choice.model !== selected.model) onToggleExtra(choice);
      return;
    }
    popover.dismiss("select");
    onPick(choice);
  };
  const toggleFavorite = (row: PickerRow) => {
    const key = modelKey(row.engine, row.model.id);
    setPrefs({
      modelFavorites: favorites.includes(key) ? favorites.filter((entry) => entry !== key) : [...favorites, key],
    });
  };

  const onKey = (event: React.KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const at = tabs.indexOf(tab) + (event.key === "ArrowDown" ? 1 : -1);
      const next = tabs[(at + tabs.length) % tabs.length];
      if (next) setTab(next);
      setActive(-1);
    } else if (mod && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const row = rows[Number(event.key) - 1];
      if (row) pick(row);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((Math.max(active, step > 0 ? -1 : 0) + step + rows.length) % Math.max(rows.length, 1));
    } else if ((event.key === "ArrowLeft" && !query)) {
      event.preventDefault();
      rail.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]")?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[Math.max(active, searching ? 0 : -1)];
      if (row) pick(row);
    }
  };

  const tabButton = (id: string, label: string, glyph: ReactNode, disabled: boolean) => (
    <button
      key={id}
      type="button"
      className="model-tab"
      aria-label={label}
      aria-pressed={tab === id}
      title={label}
      data-off={disabled || undefined}
      onClick={() => {
        setTab(id);
        setActive(-1);
        input.current?.focus();
      }}
    >
      {glyph}
    </button>
  );

  const failure = tab !== FAVORITES && !searching ? byEngine[tab]?.error : null;
  const listed = tab === FAVORITES || searching || byEngine[tab] !== undefined;

  return (
    <FloatingPanel anchor={anchor} label="Choose a model" className="model-picker" container={portalContainer} closing={closing} panelRef={panel}>
      <div ref={rail} className="model-rail" role="toolbar" aria-label="Providers">
        {tabButton(FAVORITES, "Favorites", <Star size={20} fill="currentColor" aria-hidden />, false)}
        <hr />
        {engines.map((engine) => {
          const reason = disabledReason?.(engine) ?? null;
          return tabButton(
            engine.id,
            reason
              ? `${engine.name}: Unavailable. ${reason}`
              : engine.capabilities.managed
                ? engine.name
                : `${engine.name} (Unmanaged)`,
            <EngineGlyph name={engine.name} letters={2} />,
            reason !== null,
          );
        })}
      </div>
      <div ref={main} className="model-main" onKeyDown={onKey}>
        <div className="model-search">
          <Search size={14} aria-hidden />
          <input
            ref={input}
            aria-label="Search models"
            placeholder="Search models..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </div>
        {rows.length > 0 ? (
          <Rows
            rows={rows}
            active={active}
            selected={selected}
            extra={extra}
            showEngine={searching || tab === FAVORITES}
            jumps={jumps}
            engineName={engineName}
            favorites={favorites}
            onHover={setActive}
            onPick={pick}
            onFavorite={toggleFavorite}
          />
        ) : (
          <p className="model-empty" role="status">
            {!listed
              ? "Loading models…"
              : failure
                ? failure
                : searching
                  ? "No models found"
                  : tab === FAVORITES
                    ? "No favorites yet"
                    : "No models listed"}
          </p>
        )}
      </div>
    </FloatingPanel>
  );
}

/** The closed picker in the composer: engine glyph and short model name. */
export function ModelPickerTrigger({
  engines,
  selected,
  extra = [],
  disabled,
  disabledReason,
  triggerLabel,
  onPick,
  onToggleExtra,
}: {
  engines: EngineStatus[];
  selected: Selection;
  /** Models added beside the selected one. */
  extra?: readonly Selection[];
  disabled?: boolean;
  disabledReason?(engine: EngineStatus): string | null;
  triggerLabel?: string;
  onPick(selection: Selection): void;
  onToggleExtra?(selection: Selection): void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const models = useEngineModels(selected.engine);
  const model = resolveModel(models, selected.model);
  const engine = engines.find((entry) => entry.id === selected.engine);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const name = triggerLabel ?? (model ? shortModelName(model.label) : (selected.model ?? engine?.name ?? "No engine"));

  useCommand("modelPicker.toggle", () => {
    if (button.current?.disabled || button.current?.closest("[data-side-chat]")) return false;
    button.current?.click();
  });

  return (
    <>
      <button
        ref={button}
        type="button"
        className="composer-control"
        aria-label={triggerLabel ?? model?.label ?? name}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        disabled={disabled}
        data-model-trigger
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget.getBoundingClientRect())}
      >
        {engine ? <EngineGlyph name={engine.name} /> : null}
        <span>{name}</span>
        {extra.length > 0 ? <span className="model-extra">+{extra.length}</span> : null}
        {engines.length === 0 ? <ChevronDown size={12} aria-hidden /> : null}
      </button>
      <Presence>
      {anchor ? (
        <ModelPopover
          engines={engines}
          selected={{ engine: selected.engine, model: model?.id ?? selected.model }}
          extra={extra}
          anchor={anchor}
          portalContainer={button.current?.closest("dialog")}
          disabledReason={disabledReason}
          trigger={() => button.current}
          onPick={onPick}
          onToggleExtra={onToggleExtra}
          onClose={close}
        />
      ) : null}
      </Presence>
    </>
  );
}
