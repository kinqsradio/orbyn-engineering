import { serviceSocketUrl } from "../../api/origin";
import { AppWindow, ArrowLeft, ArrowRight, Clock, CloudOff, Crosshair, EyeOff, Hand, MoreHorizontal, Plus, RotateCw, Square, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { request } from "../../api/client";
import { readToken } from "../../api/token";
import type { BrowserProfile, LocalServer, PickedElement, PreviewTab } from "../../api/types";
import { useCommand } from "../../app/shortcuts";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useConnection, useConnectionKind } from "../../state/connection";
import { useUi } from "../../state/ui";
import { useComposerChips } from "../thread/composerChipStore";
import { chipId } from "../thread/composerContext";
import { Button, IconButton } from "../../ui/controls";
import { Menu, type MenuItem } from "../../ui/Menu";
import { Presence } from "../../ui/Presence";
import { SiteIcon } from "./SiteIcon";
import { AgentCursor } from "./AgentCursor";
import { BrowserRecording } from "./BrowserRecording";
import { PreviewRecordings } from "./previewRecording";
import { PageBridge, copyFromPage } from "./PageBridge";
import { useBrowserPanels } from "./browserPanels";
import { inDesktopApp } from "../../api/shell";
import {
  RESIZE_HANDLES,
  RESIZE_KEY_HINT,
  deviceChoice,
  draggedPage,
  pageBox,
  pageSize,
  nudgedPage,
  resizeKeyStep,
  type PageSize,
  type ResizeEdge,
} from "./viewportResize";

export { pageSize };

/** A page on this machine: it loads with no network, and needs nothing from the Orbyn service. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** The Browser tab's body when the device has no network and the page needs one. */
function OfflineNotice({ onRetry }: { onRetry(): void }) {
  return (
    <div className="browser-offline" role="status">
      <CloudOff size={16} aria-hidden />
      <b>You’re offline</b>
      <span>Pages that need the network will load when you’re back.</span>
      <Button small icon={<RotateCw size={14} aria-hidden />} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

const q = encodeURIComponent;
const VIEWPORT = { width: 1280, height: 800 };

const ENGINES: Record<string, string> = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
  kagi: "https://kagi.com/search?q=",
  startpage: "https://www.startpage.com/sp/search?query=",
};

/** A URL, a local address, or words for the chosen search engine. */
export function resolveAddress(input: string, engine: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/^[^\s/]+\.[a-z]{2,}(\/|$)/i.test(text)) return `https://${text}`;
  return `${ENGINES[engine] ?? ENGINES.duckduckgo}${q(text)}`;
}

const RESIZE_DELAY_MS = 300;
/** Pixels of change, both ways together, worth asking the browser to lay out again. */
const RESIZE_SLACK = 8;
const TAB_POLL_MS = 1000;

const RECENT_LIMIT = 50;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Sizes a page can take. `null` follows the panel. */
export const DEVICES: { id: string; label: string; size: { width: number; height: number } | null; phone: boolean }[] = [
  { id: "fit", label: "Fit panel", size: null, phone: false },
  { id: "phone", label: "Phone, 393 by 852", size: { width: 393, height: 852 }, phone: true },
  { id: "large-phone", label: "Large phone, 430 by 932", size: { width: 430, height: 932 }, phone: true },
  { id: "tablet", label: "Tablet, 820 by 1180", size: { width: 820, height: 1180 }, phone: true },
  { id: "laptop", label: "Laptop, 1280 by 800", size: { width: 1280, height: 800 }, phone: false },
  { id: "desktop", label: "Desktop, 1920 by 1080", size: { width: 1920, height: 1080 }, phone: false },
];

/** The next stop up or down from a zoom, which may sit between stops. */
export function stepZoom(zoom: number, up: boolean): number {
  const next = up ? ZOOM_STEPS.find((stop) => stop > zoom) : [...ZOOM_STEPS].reverse().find((stop) => stop < zoom);
  return next ?? zoom;
}

/** Newest first, each once. */
export function addRecent(recent: string[], url: string): string[] {
  return [url, ...recent.filter((entry) => entry !== url)].slice(0, RECENT_LIMIT);
}

/** What a picked element adds to the message. It came from the page, so it is quoted. */
export function pickedText(picked: PickedElement): string {
  const lines = [`Element \`${picked.selector}\``];
  if (picked.text) lines.push(`> ${picked.text.replace(/\n+/g, " ")}`);
  lines.push("```html", picked.html.replaceAll("```", "` ` `"), "```");
  return lines.join("\n");
}

function frameSocket(threadId: string, tabId: string) {
  const token = readToken();
  const query = token ? `?token=${q(token)}` : "";
  return new WebSocket(serviceSocketUrl(`/ws/preview/${q(threadId)}/${q(tabId)}${query}`));
}

/** Where the device toolbar sends a page it is drawing at a size of its own. */
interface PageResize {
  /** The size a drag or a run of key presses has reached, while it is under way. */
  live: PageSize | null;
  /** True while the device toolbar is open, which is what offers the handles. */
  handles: boolean;
  onPreview(size: PageSize | null): void;
  onCommit(size: PageSize): void;
}

/**
 * The handles on a page's box. A drag follows the pointer and commits once, on
 * release; the arrow keys step the page's own pixels and commit after a pause,
 * so a run of presses is one resize.
 */
function ResizeHandles({
  page,
  stage,
  scale,
  onPreview,
  onCommit,
}: {
  page: PageSize;
  stage: PageSize;
  scale: number;
  onPreview(size: PageSize | null): void;
  onCommit(size: PageSize): void;
}) {
  const [dragging, setDragging] = useState<ResizeEdge | null>(null);
  /** The size a run of key presses reached, waiting to be committed as one. */
  const waiting = useRef<PageSize | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Takes the window listeners of a drag that is under way back off. */
  const detach = useRef<(() => void) | null>(null);
  const stop = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const letGo = () => {
    detach.current?.();
    detach.current = null;
  };
  // A page is left where it is when the toolbar or the panel goes away.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      detach.current?.();
    },
    [],
  );
  const press = (edge: ResizeEdge) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = resizeKeyStep(edge, event.key, event.shiftKey);
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const from = waiting.current ?? page;
    const next = nudgedPage(from, step);
    if (next.width === from.width && next.height === from.height) return;
    waiting.current = next;
    onPreview(next);
    stop();
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const size = waiting.current;
      waiting.current = null;
      if (size) onCommit(size);
    }, RESIZE_DELAY_MS);
  };
  const grab = (edge: ResizeEdge) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // The pointer wins over a size the keys had not sent yet.
    waiting.current = null;
    stop();
    letGo();
    const held = {
      edge,
      pointer: event.pointerId,
      start: page,
      x: event.clientX,
      y: event.clientY,
      latest: page,
      moved: false,
      stage: stage,
      scale: scale,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The browser may refuse capture, and the drag still works without it.
    }
    // The pointer is watched on the window, since a drag leaves the edge it started on.
    const target = event.currentTarget;
    const pull = (move: PointerEvent) => {
      if (move.pointerId !== held.pointer) return;
      move.preventDefault();
      held.moved = true;
      held.latest = draggedPage(
        held.start,
        { x: move.clientX - held.x, y: move.clientY - held.y },
        held.stage,
        held.scale,
        held.edge,
      );
      onPreview(held.latest);
    };
    const release = () => {
      letGo();
      setDragging(null);
      try {
        target.releasePointerCapture(held.pointer);
      } catch {
        // Capture may already be gone.
      }
      const same = held.latest.width === held.start.width && held.latest.height === held.start.height;
      if (!held.moved || same) {
        onPreview(null);
        return;
      }
      onCommit(held.latest);
    };
    const cancel = () => {
      // A cancelled pointer never commits, so the page keeps the size it had.
      letGo();
      setDragging(null);
      onPreview(null);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId === held.pointer) release();
    };
    const onCancel = (gone: PointerEvent) => {
      if (gone.pointerId === held.pointer) cancel();
    };
    window.addEventListener("pointermove", pull);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    detach.current = () => {
      window.removeEventListener("pointermove", pull);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    setDragging(edge);
  };
  return (
    <>
      {RESIZE_HANDLES.map(({ edge, name }) => (
        <button
          key={edge}
          type="button"
          className="browser-handle"
          data-edge={edge}
          data-dragging={dragging === edge || undefined}
          aria-label={`${name}. ${RESIZE_KEY_HINT}`}
          title={`${name}. ${RESIZE_KEY_HINT}`}
          onPointerDown={grab(edge)}
          onKeyDown={press(edge)}
        />
      ))}
    </>
  );
}

/** The page's frames, with input forwarded while you hold control. */
export function PageView({
  threadId,
  tab,
  fitted: follow = true,
  picking = false,
  resize = null,
  onPicked,
}: {
  threadId: string;
  tab: PreviewTab;
  /** False leaves the page at the size it was given. */
  fitted?: boolean;
  picking?: boolean;
  /** Set by the device toolbar while it shows a page at a size of its own. */
  resize?: PageResize | null;
  onPicked?(picked: PickedElement): void;
}) {
  const [frame, setFrame] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [stageSize, setStageSize] = useState<PageSize>({ width: 0, height: 0 });
  const stage = useRef<HTMLImageElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const pushToast = useUi((state) => state.pushToast);
  const human = tab.control === "human";
  const boxed = resize !== null;
  const page = resize?.live ?? { width: tab.width, height: tab.height };
  const box = pageBox(page, stageSize);
  useEffect(() => {
    const socket = frameSocket(threadId, tab.id);
    socket.onmessage = (event) => {
      setLost(false);
      setFrame(String(event.data));
    };
    socket.onclose = () => setLost(true);
    return () => {
      socket.onclose = null;
      socket.close();
    };
  }, [threadId, tab.id]);
  const send = (body: { kind: string; x?: number; y?: number; delta_y?: number; text?: string }) => {
    if (!human) return;
    request("POST", `/api/threads/${q(threadId)}/previews/${q(tab.id)}/input`, body).catch((failure: unknown) =>
      pushToast(`Couldn't reach the page. ${toFailure(failure).message}`),
    );
  };
  // The size the page has, or was last asked to take. The tab list only catches up
  // on its next poll, and a click mapped from the old size lands somewhere else.
  const sized = useRef({ width: tab.width, height: tab.height });
  useEffect(() => {
    sized.current = { width: tab.width, height: tab.height };
  }, [tab.width, tab.height]);
  const point = (event: MouseEvent) => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - box.left) / box.width) * sized.current.width,
      y: ((event.clientY - box.top) / box.height) * sized.current.height,
    };
  };
  const onKey = (event: KeyboardEvent) => {
    if (!human) return;
    const shortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
    const letter = event.key.toLowerCase();
    // Pasting arrives as its own event, with the text the person chose to paste.
    if (shortcut && letter === "v") return;
    event.preventDefault();
    if (shortcut && letter === "c") {
      copyFromPage(threadId, tab.id).catch((failure: unknown) =>
        pushToast(`Couldn't copy from the page. ${toFailure(failure).message}`),
      );
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) send({ kind: "text", text: event.key });
    else send({ kind: "key", text: event.key });
  };
  const onPaste = (event: ClipboardEvent) => {
    if (!human) return;
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    if (text) send({ kind: "text", text });
  };
  const onWheel = (event: WheelEvent) => send({ kind: "scroll", ...point(event), delta_y: event.deltaY });
  const fitted = useRef({ width: tab.width, height: tab.height });
  useEffect(() => {
    const element = area.current;
    if (!element || !follow) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = pageSize(entry.contentRect.width, entry.contentRect.height);
        if (Math.abs(size.width - fitted.current.width) + Math.abs(size.height - fitted.current.height) < RESIZE_SLACK) return;
        const before = sized.current;
        fitted.current = size;
        // Input sent from now on reaches the page after this resize, so it maps to the new size.
        sized.current = size;
        request("POST", `/api/threads/${q(threadId)}/previews/${q(tab.id)}/resize`, size).catch((failure: unknown) => {
          if (sized.current === size) sized.current = before;
          pushToast(`Couldn't resize the page. ${toFailure(failure).message}`);
        });
      }, RESIZE_DELAY_MS);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [threadId, tab.id, pushToast, follow]);
  // The box is sized from the stage's pixels, which no CSS rule can hand it.
  useEffect(() => {
    const element = area.current;
    if (!element || !boxed) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setStageSize((previous) =>
        previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [boxed]);
  const click = (event: MouseEvent) => {
    if (!picking) {
      send({ kind: "click", ...point(event) });
      return;
    }
    request<PickedElement>("POST", `/api/threads/${q(threadId)}/previews/${q(tab.id)}/pick`, point(event)).then(
      (picked) => onPicked?.(picked),
      (failure: unknown) => pushToast(`Couldn't read that element. ${toFailure(failure).message}`),
    );
  };
  const picture = frame ? (
    <img
      ref={stage}
      className="browser-frame"
      data-preview
      data-human={human || undefined}
      tabIndex={0}
      alt={`Page at ${tab.url}`}
      src={`data:image/jpeg;base64,${frame}`}
      onClick={click}
      onKeyDown={onKey}
      onPaste={onPaste}
      onWheel={onWheel}
    />
  ) : null;
  return (
    <div ref={area} className="browser-stage" data-picking={picking || undefined}>
      {picture && resize ? (
        <div className="browser-box" style={{ width: box.width, height: box.height }}>
          {picture}
          {/* One stream per tab: the service clears the cue itself on navigation or a resize, and a
            remount here would drop a cue sent while the new stream connects. */}
          <AgentCursor key={`${threadId}:${tab.id}`} threadId={threadId} tabId={tab.id} image={stage} />
          {resize.handles ? (
            <ResizeHandles
              page={page}
              stage={stageSize}
              scale={box.scale}
              onPreview={resize.onPreview}
              onCommit={resize.onCommit}
            />
          ) : null}
        </div>
      ) : picture ? (
        <>{picture}<AgentCursor key={`${threadId}:${tab.id}`} threadId={threadId} tabId={tab.id} image={stage} /></>
      ) : (
        <p className="browser-note">{lost ? "Browser connection was refused." : "Connecting..."}</p>
      )}
      {tab.crashed ? (
        <p className="browser-note" role="alert">
          This page keeps crashing. Close the tab and open it again.
        </p>
      ) : null}
    </div>
  );
}

/** Reachable servers from this thread's processes, and pages opened before. */
function StartPage({
  threadId,
  onOpen,
  profile,
  setProfile,
  isPrivate,
}: {
  threadId: string;
  onOpen(url: string): void;
  profile: string;
  setProfile(id: string): void;
  isPrivate: boolean;
}) {
  const profiles = useAsync("browser-profiles", (signal) =>
    request<BrowserProfile[]>("GET", "/api/browser-profiles", undefined, signal),
  );
  const servers = useAsync(`servers:${threadId}`, (signal) =>
    request<LocalServer[]>("GET", `/api/threads/${q(threadId)}/servers`, undefined, signal),
  );
  const recent = useUi((state) => state.recentUrls);
  const pushToast = useUi((state) => state.pushToast);
  const list = servers.data ?? [];
  return (
    <div className="browser-start">
      <h3>No preview yet</h3>
      <p>Type a URL above, or run a dev script. Browser-ready localhost servers will show up here automatically.</p>
      {isPrivate ? <p>This tab is private: its pages stay out of your history.</p> : null}
      {profiles.data && profiles.data.length > 0 ? (
        <label className="browser-profile">
          Profile
          <select aria-label="Profile" value={profile} onChange={(event) => setProfile(event.target.value)}>
            <option value="">None, ends with the tab</option>
            {profiles.data.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={entry.in_use}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {list.length > 0 ? (
        <ul aria-label="Local servers">
          {list.map((server) => (
            <li key={server.port}>
              <button type="button" onClick={() => onOpen(`http://localhost:${server.port}`)}>
                localhost:{server.port} <span>{server.process}</span>
              </button>
              {server.in_checkout ? (
                <IconButton
                  label={`Stop localhost:${server.port}`}
                  onClick={() => {
                    request<void>("POST", `/api/threads/${q(threadId)}/servers/${server.pid}/stop`).then(servers.reload, (failure: unknown) =>
                      pushToast(`Couldn't stop it. ${toFailure(failure).message}`),
                    );
                  }}
                >
                  <Square size={12} aria-hidden />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {recent.length > 0 ? (
        <ul aria-label="Recent pages">
          {recent.map((url) => (
            <li key={url}>
              <button type="button" onClick={() => onOpen(url)}>
                {url}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function BrowserPanel({ threadId }: { threadId: string }) {
  const moved = useBrowserPanels((state) => state.moved[threadId]);
  const move = useBrowserPanels((state) => state.move);
  return (
    <div className="browser-panels">
      <section className="browser-pane" aria-label="Browser panel">
        <BrowserPane threadId={threadId} excludedTabId={moved} onMove={(id) => move(threadId, id)} />
      </section>
      {moved ? <section className="browser-pane" aria-label="Second Browser panel">
        <BrowserPane threadId={threadId} onlyTabId={moved} onMove={() => move(threadId, null)} />
      </section> : null}
    </div>
  );
}

export function BrowserPane({ threadId, onlyTabId, excludedTabId, onMove, detached = false }: {
  threadId: string;
  onlyTabId?: string;
  excludedTabId?: string;
  onMove?(tabId: string): void;
  detached?: boolean;
}) {
  const base = `/api/threads/${q(threadId)}/previews`;
  const pane = useRef<HTMLDivElement>(null);
  const ownsFocus = () => Boolean(pane.current?.contains(document.activeElement)) ||
    (document.activeElement === document.body && (!onlyTabId || detached));
  const tabs = useAsync(`previews:${threadId}`, (signal) => request<PreviewTab[]>("GET", base, undefined, signal));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftTab, setDraftTab] = useState(false);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordings] = useState(() => new PreviewRecordings());
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [isPrivate, setPrivate] = useState(false);
  const [profile, setProfile] = useState("");
  /** The device each tab is shown as, while the toolbar is open. */
  const [devices, setDevices] = useState<Record<string, string>>({});
  /** The size a handle has dragged or stepped the page to, before it is committed. */
  const [live, setLive] = useState<PageSize | null>(null);
  const [toolbar, setToolbar] = useState(false);
  const recent = useUi((state) => state.recentUrls);
  const waiting = useUi((state) => state.previewRequest);
  const searchEngine = useUi((state) => state.previewSearchEngine);
  const setPrefs = useUi((state) => state.setPrefs);
  const pushToast = useUi((state) => state.pushToast);
  const reload = tabs.reload;
  useCommand("preview.focusUrl", () => {
    pane.current?.querySelector<HTMLInputElement>("[data-preview-address]")?.focus();
  }, ownsFocus);
  const list = (tabs.data ?? []).filter((tab) => tab.id !== excludedTabId && (!onlyTabId || tab.id === onlyTabId));
  const active = draftTab ? null : (list.find((tab) => tab.id === activeId) ?? list[0] ?? null);

  const remember = (url: string) => {
    setPrefs({ recentUrls: addRecent(useUi.getState().recentUrls, url) });
  };
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
      reload();
    } catch (failure) {
      setError(toFailure(failure).message);
    } finally {
      setBusy(false);
    }
  };
  const go = (raw: string) => {
    if (!active && onlyTabId) return;
    const url = resolveAddress(raw, searchEngine);
    setAddress(url);
    if (!(active?.private ?? isPrivate)) remember(url);
    void act(async () => {
      if (active) {
        await request("POST", `${base}/${q(active.id)}/navigate`, { url });
      } else {
        const how = { private: isPrivate, ...(profile ? { profile } : {}) };
        const made = await request<PreviewTab>("POST", base, { url, ...VIEWPORT, ...how });
        setDraftTab(false);
        setActiveId(made.id);
        setPrivate(false);
      }
    });
  };
  const view = (change: { zoom?: number; appearance?: string; mobile?: boolean }) => {
    if (active) void act(() => request("POST", `${base}/${q(active.id)}/view`, change));
  };
  const reloadPage = (hard: boolean) => {
    if (active) void act(() => request("POST", `${base}/${q(active.id)}/reload`, { hard }));
  };
  const clear = (what: { cookies?: boolean; cache?: boolean }) => {
    if (active) void act(() => request("POST", `${base}/${q(active.id)}/clear`, what));
  };
  const chosen = active ? (devices[active.id] ?? "fit") : "fit";
  const size = { width: active?.width ?? 0, height: active?.height ?? 0 };
  // A resized page is no preset, so the select stops claiming one.
  const device = active ? deviceChoice(chosen, size, DEVICES) : "fit";
  /** What the toolbar reads out, which follows the handles while they move. */
  const shownSize = live ?? size;
  useEffect(() => {
    setLive(null);
  }, [active?.id, toolbar, device]);
  /** One resize for a whole drag or run of key presses, then the tab list catches up. */
  const commitResize = (next: PageSize) => {
    if (!active) return;
    request("POST", `${base}/${q(active.id)}/resize`, next).then(
      () => void reload().then(() => setLive(null)),
      (failure: unknown) => {
        // The page keeps the size it had.
        setLive(null);
        pushToast(`Couldn't resize the page. ${toFailure(failure).message}`);
      },
    );
  };
  /** Rotates the chosen preset, or the size a custom page has reached. */
  const rotate = () => {
    if (!active || device === "fit") return;
    if (device !== "custom") {
      setDevice(device, true);
      return;
    }
    setLive(null);
    void act(() => request("POST", `${base}/${q(active.id)}/resize`, pageSize(active.height, active.width)));
  };
  const setDevice = (id: string, rotate = false) => {
    // Custom is what the select says about a size a handle already set.
    if (!active || id === "custom") return;
    const preset = DEVICES.find((entry) => entry.id === id);
    setDevices((all) => ({ ...all, [active.id]: id }));
    if (!preset?.size) {
      view({ mobile: false });
      return;
    }
    const next = rotate ? { width: active.height, height: active.width } : preset.size;
    void act(async () => {
      await request("POST", `${base}/${q(active.id)}/resize`, next);
      await request("POST", `${base}/${q(active.id)}/view`, { mobile: preset.phone });
    });
  };
  const openWaiting = useRef(go);
  useEffect(() => {
    openWaiting.current = go;
  });
  useEffect(() => {
    if (waiting === null || onlyTabId) return;
    useUi.getState().showInBrowser(null);
    // An empty request only brings the panel forward, for a tab already made.
    if (typeof waiting === "object") {
      setActiveId(waiting.tabId);
      setDraftTab(false);
      reload();
    } else if (waiting) openWaiting.current(waiting);
    else reload();
  }, [waiting, reload, onlyTabId]);
  const onPicked = (picked: PickedElement) => {
    useComposerChips.getState().add(threadId, {
      id: chipId(),
      kind: "annotation",
      url: active?.url ?? "",
      selector: picked.selector,
      text: picked.text,
      html: picked.html,
    });
    useUi.getState().pushToast("Element added to your message");
    setPicking(false);
  };
  const moreItems = (tab: PreviewTab): MenuItem[] => [
    { label: "Hard reload", onSelect: () => reloadPage(true) },
    { label: "Zoom in", disabled: stepZoom(tab.zoom, true) === tab.zoom, onSelect: () => view({ zoom: stepZoom(tab.zoom, true) }) },
    { label: "Zoom out", disabled: stepZoom(tab.zoom, false) === tab.zoom, onSelect: () => view({ zoom: stepZoom(tab.zoom, false) }) },
    { label: "Actual size", disabled: tab.zoom === 1, onSelect: () => view({ zoom: 1 }) },
    {
      label: "Appearance",
      separatorBefore: true,
      children: [
        { label: "System", selected: tab.appearance === "system", onSelect: () => view({ appearance: "system" }) },
        { label: "Light", selected: tab.appearance === "light", onSelect: () => view({ appearance: "light" }) },
        { label: "Dark", selected: tab.appearance === "dark", onSelect: () => view({ appearance: "dark" }) },
      ],
    },
    { label: toolbar ? "Hide device toolbar" : "Show device toolbar", separatorBefore: true, onSelect: () => setToolbar(!toolbar) },
    ...(!detached ? [{ label: "Float over chat", onSelect: () => useUi.getState().setPreviewFloat({ threadId, tabId: tab.id }) }] : []),
    ...(onMove ? [{ label: onlyTabId ? "Move to Browser panel" : "Move to another panel", onSelect: () => onMove(tab.id) }] : []),
    { label: "Open in separate window", disabled: !inDesktopApp(), onSelect: () => void act(() => request("POST", `${base}/${q(tab.id)}/window`)) },
    { label: "Clear cookies", separatorBefore: true, destructive: true, onSelect: () => clear({ cookies: true }) },
    { label: "Clear cache", destructive: true, onSelect: () => clear({ cache: true }) },
  ];
  const step = (back: boolean) => {
    if (!active) return;
    void act(() => request("POST", `${base}/${q(active.id)}/history`, { back }));
  };
  // A link clicked in the page moves the tab with nobody telling this side.
  const watching = active !== null || Boolean(onlyTabId);
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(reload, TAB_POLL_MS);
    return () => clearInterval(timer);
  }, [watching, reload]);
  const shown = active?.url ?? "";
  useCommand("preview.refresh", () => {
    if (!shown) return false;
    go(shown);
  }, ownsFocus);
  // Keys can outrun the tab list, so each press steps from the last one sent.
  const sentZoom = useRef<number | null>(null);
  const shownZoom = active?.zoom;
  useEffect(() => {
    if (shownZoom === sentZoom.current) sentZoom.current = null;
  }, [shownZoom]);
  const zoomTo = (zoom: (from: number) => number) => {
    if (!active) return false;
    sentZoom.current = zoom(sentZoom.current ?? active.zoom);
    view({ zoom: sentZoom.current });
  };
  useCommand("preview.zoomIn", () => zoomTo((from) => stepZoom(from, true)), ownsFocus);
  useCommand("preview.zoomOut", () => zoomTo((from) => stepZoom(from, false)), ownsFocus);
  useCommand("preview.resetZoom", () => zoomTo(() => 1), ownsFocus);
  const human = active?.control === "human";
  // Offline, a page on this machine still opens; anything else waits for the network. Sending to
  // the thread needs the Orbyn service, so while it is away Pick element is off and says why.
  const connection = useConnectionKind();
  const waitsForNetwork = connection === "offline" && !(active && isLocalUrl(active.url));
  const serviceAway = connection === "service-down";
  const retryNetwork = () => {
    useConnection.getState().setOffline(navigator.onLine === false);
    reload();
  };

  return (
    <div ref={pane} className="browser-panel">
      {waitsForNetwork && list.length === 0 ? null : <div className="browser-tabs" role="tablist" aria-label="Browser tabs">
        {list.map((tab) => (
          <span key={tab.id} className="surface-tab" data-selected={tab.id === active?.id || undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active?.id}
              onClick={() => {
                setDraftTab(false);
                setActiveId(tab.id);
              }}
            >
              <SiteIcon tab={tab} />
              {tab.title || tab.url.replace(/^https?:\/\//, "") || "New tab"}
            </button>
            <IconButton
              label="Close tab"
              onClick={() => void act(() => request("DELETE", `${base}/${q(tab.id)}`))}
            >
              <X size={12} aria-hidden />
            </IconButton>
          </span>
        ))}
        {!onlyTabId ? <><IconButton
          label="New tab"
          onClick={() => {
            setPrivate(false);
            setDraftTab(true);
          }}
        >
          <Plus size={14} aria-hidden />
        </IconButton>
        <IconButton
          label="New private tab"
          onClick={() => {
            setPrivate(true);
            setDraftTab(true);
          }}
        >
          <EyeOff size={14} aria-hidden />
        </IconButton></> : null}
        {active && !detached && inDesktopApp() ? (
          <span className="browser-popout">
            <IconButton
              label="Open in separate window"
              onClick={() => void act(() => request("POST", `${base}/${q(active.id)}/window`))}
            >
              <AppWindow size={14} aria-hidden />
            </IconButton>
          </span>
        ) : null}
        {onlyTabId && onMove ? <IconButton label="Close second Browser panel" onClick={() => onMove(onlyTabId)}><X size={14} aria-hidden /></IconButton> : null}
      </div>}
      {waitsForNetwork ? <OfflineNotice onRetry={retryNetwork} /> : <>
      <div className="browser-bar">
        <IconButton label="Back" disabled={!active?.can_go_back} onClick={() => step(true)}>
          <ArrowLeft size={14} aria-hidden />
        </IconButton>
        <IconButton label="Forward" disabled={!active?.can_go_forward} onClick={() => step(false)}>
          <ArrowRight size={14} aria-hidden />
        </IconButton>
        <IconButton label="Reload" disabled={!active} onClick={() => go(shown)}>
          <RotateCw size={14} aria-hidden />
        </IconButton>
        <input
          key={shown}
          data-preview-address
          list={`browser-history-${onlyTabId ?? "main"}`}
          aria-label="Search or enter URL"
          placeholder="Search or enter URL"
          disabled={Boolean(onlyTabId) && !active}
          defaultValue={shown || address}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.currentTarget.value.trim()) go(event.currentTarget.value);
          }}
        />
        <datalist id={`browser-history-${onlyTabId ?? "main"}`}>
          {recent.map((url) => (
            <option key={url} value={url} />
          ))}
        </datalist>
        {active ? (
          <>
            {!detached ? <IconButton label={serviceAway ? "Pick element, unavailable" : "Pick an element"} pressed={picking && !serviceAway} disabled={serviceAway} onClick={() => setPicking(!picking)}>
              <Crosshair size={14} aria-hidden />
            </IconButton> : null}
            <IconButton
              label={human ? "Give control back" : "Take control"}
              pressed={human}
              onClick={() => void act(() => request("POST", `${base}/${q(active.id)}/control`, { human: !human }))}
            >
              <Hand size={14} aria-hidden />
            </IconButton>
            <IconButton
              label="More page actions"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ x: box.right - 180, y: box.bottom + 4 });
              }}
            >
              <MoreHorizontal size={14} aria-hidden />
            </IconButton>
          </>
        ) : null}
      </div>
      {active ? <BrowserRecording key={`${threadId}:${active.id}`} tab={active}
        endpoint={`${base}/${q(active.id)}/recording`} actions={recordings} refresh={async () => {
          // Recording writes need a rejecting read; useAsync.reload intentionally
          // consumes read errors for the general panel polling flow.
          const fresh = await request<PreviewTab[]>("GET", base);
          const target = fresh.find((tab) => tab.id === active.id);
          if (!target) throw new Error("The recorded tab closed before its status could be read.");
          if (recordings.owns(`${base}/${q(active.id)}/recording`)) tabs.setData(fresh);
          return target;
        }} /> : null}
      <Presence>{menu && active ? <Menu x={menu.x} y={menu.y} label="Page actions" items={moreItems(active)} onClose={() => setMenu(null)} /> : null}</Presence>
      {toolbar && active ? (
        <div className="browser-devices" role="toolbar" aria-label="Device toolbar">
          <select aria-label="Device" value={device} onChange={(event) => setDevice(event.target.value)}>
            {DEVICES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            {device === "custom" ? (
              <option value="custom">{`Custom, ${shownSize.width} by ${shownSize.height}`}</option>
            ) : null}
          </select>
          <span>
            {shownSize.width} by {shownSize.height}
          </span>
          <IconButton label="Rotate" disabled={device === "fit"} onClick={rotate}>
            <RotateCw size={14} aria-hidden />
          </IconButton>
        </div>
      ) : null}
      {serviceAway && active ? (
        <p className="conn-banner conn-panel-banner" role="status">
          <Clock size={13} aria-hidden />
          <span>Sending to the thread is paused while the service is away.</span>
        </p>
      ) : null}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      {active ? <PageBridge threadId={threadId} tab={active} onChanged={reload} /> : null}
      {active ? (
        <PageView
          threadId={threadId}
          tab={active}
          fitted={!detached && device === "fit"}
          picking={picking && !serviceAway}
          resize={device === "fit" && !detached ? null : { live, handles: device !== "fit" && toolbar, onPreview: setLive, onCommit: commitResize }}
          onPicked={onPicked}
        />
      ) : busy ? (
        <p className="browser-note" role="status">
          Connecting...
        </p>
      ) : onlyTabId ? (
        <p className="browser-note" role="status">{tabs.status === "loading" ? "Connecting..." : "This preview tab is closed."}</p>
      ) : (
        <StartPage threadId={threadId} onOpen={go} profile={profile} setProfile={setProfile} isPrivate={isPrivate} />
      )}
      </>}
    </div>
  );
}
