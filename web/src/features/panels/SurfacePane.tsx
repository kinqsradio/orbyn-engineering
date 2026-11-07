import { CloudOff, Maximize2, Minimize2, MoreHorizontal, Plus, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Thread } from "../../api/types";
import { useUi, type RightTab } from "../../state/ui";
import { Button, IconButton } from "../../ui/controls";
import { ActivityPanel } from "./ActivityPanel";
import { BrowserPanel } from "./BrowserPanel";
import { DiffPanel } from "./DiffPanel";
import { FilesPanel } from "./FilesPanel";
import { LinkedPulls } from "./LinkedPulls";
import { SideChatPane } from "./SideChatPane";
import { fitTabs, RIGHT_TABS } from "./tabs";
import { useClosedTabs } from "./closedTabs";
import { clampPanelWidth, dragPanelWidth, PANEL_DEFAULT, snapPoints } from "./panelWidth";
import { useConnectionKind } from "../../state/connection";
import { Menu, type MenuItem } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";

/** The More button: a 24px icon button. */
const MORE_WIDTH = 24;
const MORE_MENU_WIDTH = 210;
/** The one line under "Waiting for the Orbyn service", by tab. The Browser is not here: it stays usable. */
const WAITING_LINE: Partial<Record<RightTab, string>> = {
  diff: "The diff comes back when the service does.",
  files: "Files open again as soon as it is back.",
  activity: "Activity shows again as soon as it is back.",
  side: "Your side chats open again as soon as it is back. Nothing is lost.",
};
/** Tabs that need this device's network. Diff, Files, Activity and the terminal keep working offline. */
const NEEDS_NETWORK: readonly RightTab[] = ["browser", "side", "pulls"];

/**
 * The panel's left edge. Dragging it resizes the panel, snapping to 380, 520 or 720 px within 12 px
 * and staying between 320 px and 60% of the window; a pill shows the width and faint ticks mark the
 * snap points while it moves. Double click returns to 380 px. The width is saved when the drag ends.
 */
export function PaneResizer() {
  const setWidth = useUi((state) => state.setPanelWidth);
  const [dragging, setDragging] = useState<number | null>(null);
  return (
    <>
      <div
        className="pane-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        title="Drag to resize"
        onDoubleClick={() => setWidth(PANEL_DEFAULT)}
        onPointerDown={(event) => {
          const pane = event.currentTarget.parentElement;
          if (!pane) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const right = pane.getBoundingClientRect().right;
          const handle = event.currentTarget;
          pane.dataset.resizing = "";
          let current = clampPanelWidth(pane.getBoundingClientRect().width, window.innerWidth);
          setDragging(current);
          const move = (moved: PointerEvent) => {
            current = dragPanelWidth(right - moved.clientX, window.innerWidth);
            pane.style.width = `${current}px`;
            setDragging(current);
          };
          const stop = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("lostpointercapture", stop);
            delete pane.dataset.resizing;
            setDragging(null);
            setWidth(current);
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("lostpointercapture", stop);
        }}
      />
      {dragging === null ? null : (
        <>
          {snapPoints(window.innerWidth)
            .filter((point) => point !== dragging)
            .map((point) => (
              <span key={point} className="pane-tick" style={{ right: point }} aria-hidden>
                <i>{point}</i>
              </span>
            ))}
          <span className="pane-width" role="status">
            {dragging} px
          </span>
        </>
      )}
    </>
  );
}

/**
 * How the pane sits in the window: "docked" beside the thread, "overlay" over its right side under
 * the header (medium and small windows), or "sheet" in place of the thread (phone).
 */
export type PaneMode = "docked" | "overlay" | "sheet";

export function SurfacePane({
  thread,
  mode,
  closing,
  moves,
  maximized,
  details = null,
  onToggleMaximize,
  onReturn,
}: {
  thread: Thread;
  mode: PaneMode;
  closing: boolean;
  /** False while the pane is part of the page as it first appeared. */
  moves: boolean;
  maximized: boolean;
  /** The thread's details card, which sits at the top of the panel above its tabs. */
  details?: ReactNode;
  onToggleMaximize(): void;
  onReturn(): void;
}) {
  // With no surface chosen yet the panel shows the first.
  const tab: RightTab = useUi((state) => state.panelTab) ?? "diff";
  const toggle = useUi((state) => state.togglePanel);
  const closedTabs = useClosedTabs((state) => state.closed);
  const reopenTab = useClosedTabs((state) => state.reopen);
  const rowTabs = RIGHT_TABS.filter(({ id }) => !closedTabs.includes(id));
  const width = useUi((state) => state.panelWidth);
  // A header row of its own, with Back to thread: the phone's sheet, and the reading layout's floating drawer.
  const reading = useUi((state) => state.workspaceLayout === "reading");
  const drawer = mode === "sheet" || (reading && mode === "docked");

  const list = useRef<HTMLDivElement>(null);
  const kind = useConnectionKind();
  // When the row is narrow, the tabs that don't fit fold into More; the open tab always stays.
  const widths = useRef(new Map<RightTab, number>());
  const [shown, setShown] = useState<readonly RightTab[]>(() => RIGHT_TABS.map(({ id }) => id));
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number } | null>(null);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const folded = rowTabs.some(({ id }) => !shown.includes(id));
  const latest = useRef({ tab, folded, ids: rowTabs.map(({ id }) => id) });
  latest.current = { tab, folded, ids: rowTabs.map(({ id }) => id) };
  const refit = useCallback(() => {
    const row = list.current;
    if (!row) return;
    for (const element of row.querySelectorAll<HTMLElement>('[role="tab"]')) {
      const id = element.id.replace("context-tab-", "") as RightTab;
      if (element.offsetWidth > 0) widths.current.set(id, element.offsetWidth);
    }
    // The row is narrower by the More button while it shows.
    const room = row.clientWidth + (latest.current.folded ? MORE_WIDTH : 0);
    const next = fitTabs(latest.current.ids, widths.current, room, MORE_WIDTH, latest.current.tab);
    setShown((current) => (current.length === next.length && current.every((id, i) => id === next[i]) ? current : next));
  }, []);
  useLayoutEffect(() => {
    const row = list.current;
    if (!row) return;
    refit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
    observer?.observe(row);
    return () => observer?.disconnect();
  }, [refit]);
  const closedKey = closedTabs.join();
  useLayoutEffect(refit, [tab, closedKey, refit]);
  const hiddenTabs: MenuItem[] = rowTabs.filter(({ id }) => !shown.includes(id)).map(({ id, text, icon: Icon }) => ({
    label: text,
    icon: <Icon size={14} aria-hidden />,
    onSelect: () => toggle(id),
  }));
  // The "+" lists the closed surfaces. "Reset tab order" waits for tab reordering (data-gated).
  const closedItems: MenuItem[] = RIGHT_TABS.filter(({ id }) => closedTabs.includes(id)).map(({ id, text, icon: Icon }) => ({
    label: text,
    icon: <Icon size={14} aria-hidden />,
    onSelect: () => {
      reopenTab(id);
      toggle(id);
    },
  }));
  // One Tab stop: the chosen tab.
  const stop = tab;
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = rowTabs.findIndex(({ id }) => id === stop);
    const next =
      event.key === "ArrowRight" ? (at + 1) % rowTabs.length
      : event.key === "ArrowLeft" ? (at - 1 + rowTabs.length) % rowTabs.length
      : event.key === "Home" ? 0
      : event.key === "End" ? rowTabs.length - 1
      : -1;
    const target = rowTabs[next];
    if (!target) return;
    event.preventDefault();
    toggle(target.id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`#context-tab-${target.id}`)?.focus());
  };

  return (
    <aside
      className="context"
      aria-label="Thread context"
      data-closing={closing || undefined}
      data-moves={moves || undefined}
      data-maximized={maximized || undefined}
      data-mode={mode}
      style={mode !== "sheet" && !maximized ? { width: width ?? (drawer ? undefined : PANEL_DEFAULT) } : undefined}
    >
      {mode === "sheet" || maximized ? null : <PaneResizer />}
      {drawer ? (
        <header className="drawer-head">
          <Button small onClick={onReturn}>
            Back to thread
          </Button>
          <span className="end">
            {mode === "sheet" ? null : (
              <IconButton label={maximized ? "Restore" : "Maximise panel"} onClick={onToggleMaximize}>
                {maximized ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
              </IconButton>
            )}
            <IconButton label="Close side panel" onClick={onReturn}>
              <X size={16} aria-hidden />
            </IconButton>
          </span>
        </header>
      ) : null}
      {details}
      <header className="context-head">
        <div ref={list} className="tabs" role="tablist" aria-label="Context" onKeyDown={onTabKey}>
          {rowTabs.filter(({ id }) => shown.includes(id)).map(({ id, label, text }) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="ptab"
              id={`context-tab-${id}`}
              data-selected={tab === id || undefined}
              aria-selected={tab === id}
              tabIndex={stop === id ? 0 : -1}
              aria-controls={tab === id ? `context-${id}` : undefined}
              aria-label={text === label ? undefined : label}
              data-offline={kind === "offline" && NEEDS_NETWORK.includes(id) ? "" : undefined}
              onClick={() => {
                if (tab !== id) toggle(id);
              }}
            >
              {text}
              {kind === "offline" && NEEDS_NETWORK.includes(id) ? <CloudOff size={12} aria-hidden /> : null}
            </button>
          ))}
        </div>
        <div className="layout-toggles end">
          {folded ? (
            <IconButton
              className="tabs-more"
              label="More tabs"
              pressed={moreMenu !== null}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMoreMenu(moreMenu ? null : { x: rect.right - MORE_MENU_WIDTH, y: rect.bottom + 4 });
              }}
            >
              <MoreHorizontal size={16} aria-hidden />
            </IconButton>
          ) : null}
          {closedItems.length > 0 ? (
            <IconButton
              label="Open a tab"
              pressed={plusMenu !== null}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setPlusMenu(plusMenu ? null : { x: rect.right - MORE_MENU_WIDTH, y: rect.bottom + 4 });
              }}
            >
              <Plus size={16} aria-hidden />
            </IconButton>
          ) : null}
          {drawer ? null : (
            <>
              <IconButton label={maximized ? "Restore" : "Maximise panel"} onClick={onToggleMaximize}>
                {maximized ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
              </IconButton>
              <IconButton label="Close side panel" onClick={onReturn}>
                <X size={16} aria-hidden />
              </IconButton>
            </>
          )}
        </div>
      </header>
      <Presence>
        {plusMenu ? (
          <Menu x={plusMenu.x} y={plusMenu.y} label="Closed tabs" items={closedItems} onClose={() => setPlusMenu(null)} />
        ) : null}
      </Presence>
      <Presence>
        {moreMenu ? (
          <Menu
            x={moreMenu.x}
            y={moreMenu.y}
            label="Hidden tabs"
            heading="Hidden tabs"
            items={hiddenTabs}
            onClose={() => setMoreMenu(null)}
          />
        ) : null}
      </Presence>
      <div className="context-body" data-connection={kind ?? undefined}>
        {kind === "offline" && tab !== null && tab !== "browser" && NEEDS_NETWORK.includes(tab) ? (
          <p className="conn-banner conn-panel-banner" role="status">
            <CloudOff size={13} aria-hidden />
            <span>You’re offline.</span>
          </p>
        ) : null}
        {kind === "service-down" && tab !== null && tab !== "browser" ? (
          <div className="conn-wait">
            <b>Waiting for the Orbyn service</b>
            {WAITING_LINE[tab] ? <span>{WAITING_LINE[tab]}</span> : null}
          </div>
        ) : (
          <div id={`context-${tab}`} role="tabpanel" aria-labelledby={`context-tab-${tab}`} className="tabpanel">
            {tab === "browser" ? (
              <BrowserPanel threadId={thread.id} />
            ) : tab === "diff" ? (
              <DiffPanel threadId={thread.id} />
            ) : tab === "files" ? (
              <FilesPanel threadId={thread.id} />
            ) : tab === "activity" ? (
              <ActivityPanel key={thread.id} threadId={thread.id} />
            ) : tab === "side" ? (
              <SideChatPane parent={thread} />
            ) : (
              <LinkedPulls thread={thread} />
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
